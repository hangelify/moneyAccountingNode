// First: turns the batch on before AppModule is imported.
import './setup/enable-bill-batch';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/core';
import request from 'supertest';
import sharp from 'sharp';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  createTestApp,
  registerUser,
  seedAiRequest,
  type TestUser,
} from './utils/app';
import { BillPhotoService } from '../src/modules/bill/bill-photo.service';
import { STORAGE_SERVICE } from '../src/modules/storage/storage.service';
import type {
  ImageMediaType,
  StorageService,
} from '../src/modules/storage/storage.service';
import { AI_USAGE_LIMITS } from '../src/modules/ai-gateway/internal/ai-usage-limits';
import type { AiUsageLimits } from '../src/modules/ai-gateway/internal/ai-usage-limits';
import { AiGatewayService } from '../src/modules/ai-gateway/ai-gateway.service';
import { AiBudgetExceededError } from '../src/modules/ai-gateway/errors';
import { redisConnectionOptions } from '../src/config/redis';
import { BILL_PHOTO_QUEUE } from '../src/modules/bill/batch/bill-batch.env';
import { BillPhotoProcessor } from '../src/modules/bill/batch/bill-photo.processor';
import { BillEventsPublisher } from '../src/modules/bill/batch/bill-events.publisher';
import type { BillBatchResponseDto } from '../src/modules/bill/batch/dto/bill-batch-response.dto';
import type { BillDetailResponseDto } from '../src/modules/bill/dto/bill-detail-response.dto';

const AI_REQUEST_ID = '00000000-0000-4000-8000-0000000000b1';
const NOT_A_RECEIPT_MESSAGE =
  'The photo is not a receipt or no items were recognized on it';

/** Stands in for S3: keys as S3StorageService builds them. */
class MemoryStorage implements StorageService {
  readonly files = new Map<
    string,
    { buffer: Buffer; mediaType: ImageMediaType }
  >();

  put(buffer: Buffer, mediaType: ImageMediaType, householdId?: string) {
    const ext = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
    }[mediaType];
    const hash = createHash('sha256').update(buffer).digest('hex');
    const key = `ai/images/${householdId ?? 'none'}/${hash}.${ext}`;
    this.files.set(key, { buffer, mediaType });
    return Promise.resolve({ key });
  }

  exists(key: string) {
    return Promise.resolve(this.files.has(key));
  }

  get(key: string) {
    const file = this.files.get(key);
    if (!file)
      return Promise.reject(new Error(`Stored image not found: ${key}`));
    return Promise.resolve(file);
  }

  getSignedUrl(key: string) {
    return Promise.resolve(`http://storage.e2e.test/${key}`);
  }
}

/** A distinct JPEG per width; the mocked AI tells photos apart by width. */
function photo(width: number): Promise<Buffer> {
  return sharp({
    create: { width, height: 48, channels: 3, background: '#fff' },
  })
    .jpeg()
    .toBuffer();
}

interface SseEvent {
  type: string;
  data: unknown;
}

interface EventStream {
  status: number;
  contentType: string | null;
  events: SseEvent[];
  /** Resolves with the first event (already received or not) matching. */
  waitFor(
    match: (e: SseEvent) => boolean,
    timeoutMs?: number,
  ): Promise<SseEvent>;
  close(): void;
}

/** Reads `GET households/:hid/bills/events` with fetch and a small SSE parser. */
async function openEvents(
  baseUrl: string,
  hid: string,
  token: string,
): Promise<EventStream> {
  const abort = new AbortController();
  const res = await fetch(`${baseUrl}/households/${hid}/bills/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: abort.signal,
  });
  const events: SseEvent[] = [];
  const listeners = new Set<() => void>();
  if (res.ok && res.body) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let type = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) type = line.slice(6).trim();
              else if (line.startsWith('data:'))
                data.push(line.slice(5).trim());
            }
            if (!data.length && type === 'message') continue;
            const raw = data.join('\n');
            let parsed: unknown = raw;
            try {
              parsed = JSON.parse(raw);
            } catch {
              // Plain-text data, e.g. the empty ping.
            }
            events.push({ type, data: parsed });
            for (const l of listeners) l();
          }
        }
      } catch {
        // Aborted by close().
      }
    })();
  } else {
    await res.body?.cancel();
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    events,
    waitFor(match, timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = events.find(match);
          if (!found) return false;
          listeners.delete(check);
          clearTimeout(timer);
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(
            new Error(
              `No matching event in ${timeoutMs} ms; got ${JSON.stringify(events)}`,
            ),
          );
        }, timeoutMs);
        if (!check()) listeners.add(check);
      });
    },
    close: () => abort.abort(),
  };
}

const ofBatch = (batchId: string) => (e: SseEvent) =>
  (e.data as { batch_id?: string } | null)?.batch_id === batchId;

describe('Batch photo parsing with the queue enabled (e2e)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  const storage = new MemoryStorage();
  const streams: EventStream[] = [];
  // Widths of photos the mocked AI does not recognize as receipts.
  const notReceipts = new Set<number>();
  const parseAndCategorize = jest.fn(async (image: Buffer) => {
    const { width } = await sharp(image).metadata();
    return {
      parsed: {
        draft_id: '',
        market_name: 'Lidl',
        bill_date: '2026-11-01',
        currency: null,
        total_amount: 12.5,
        fiscal_register_id: null,
        fiscal_receipt_number: null,
        purchase_time: null,
        items: [],
      },
      requestId: AI_REQUEST_ID,
      isReceipt: !notReceipts.has(width),
    };
  });

  const overrides = (builder: TestingModuleBuilder) =>
    builder
      .overrideProvider(BillPhotoService)
      .useValue({ parseAndCategorize })
      .overrideProvider(STORAGE_SERVICE)
      .useValue(storage);

  const api = (user: TestUser) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(`/households/${user.householdId}/${path}`)
        .set('Authorization', `Bearer ${user.accessToken}`),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(`/households/${user.householdId}/${path}`)
        .set('Authorization', `Bearer ${user.accessToken}`),
    put: (path: string) =>
      request(app.getHttpServer())
        .put(`/households/${user.householdId}/${path}`)
        .set('Authorization', `Bearer ${user.accessToken}`),
  });

  /**
   * Opens a stream and waits until it receives a probe event: the hub's
   * Redis subscription is opened by the first stream, asynchronously.
   */
  async function listen(user: TestUser): Promise<EventStream> {
    const stream = await openEvents(
      baseUrl,
      user.householdId,
      user.accessToken,
    );
    streams.push(stream);
    expect(stream.status).toBe(200);
    const probe = `probe-${randomUUID()}`;
    const publisher = app.get(BillEventsPublisher);
    const publishProbe = () =>
      publisher.publish(user.householdId, {
        type: 'batch.completed',
        data: {
          batch_id: probe,
          total: 0,
          done: 0,
          failed: 0,
          created_by_user_id: null,
        },
      });
    await publishProbe();
    const retry = setInterval(() => void publishProbe(), 100);
    try {
      await stream.waitFor(ofBatch(probe), 5_000);
    } finally {
      clearInterval(retry);
    }
    return stream;
  }

  async function batchRows(userId: string): Promise<number> {
    const rows = (await app
      .get(MikroORM)
      .em.getConnection()
      .execute(
        'select count(*) as n from bill_batches where created_by_user_id = ?',
        [userId],
      )) as { n: string }[];
    return Number(rows[0].n);
  }

  async function queuedJobs(): Promise<number> {
    const queue = new Queue(BILL_PHOTO_QUEUE, {
      connection: redisConnectionOptions(),
    });
    try {
      const counts = await queue.getJobCounts();
      return Object.values(counts).reduce((a, b) => a + b, 0);
    } finally {
      await queue.close();
    }
  }

  async function userId(user: TestUser): Promise<string> {
    const rows = (await app
      .get(MikroORM)
      .em.getConnection()
      .execute('select id from users where email = ?', [user.email])) as {
      id: string;
    }[];
    return rows[0].id;
  }

  beforeAll(async () => {
    const queue = new Queue(BILL_PHOTO_QUEUE, {
      connection: redisConnectionOptions(),
    });
    await queue.obliterate({ force: true });
    await queue.close();

    app = await createTestApp({ override: overrides });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    await seedAiRequest(app, AI_REQUEST_ID);
    alice = await registerUser(app, 'batch-alice');
    bob = await registerUser(app, 'batch-bob');
    carol = await registerUser(app, 'batch-carol');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    for (const s of streams) s.close();
    await app?.close();
  });

  it('boots with the batch enabled and runs the worker', () => {
    expect(process.env.BILL_BATCH_ENABLED).toBe('true');
    expect(app.get(BillPhotoProcessor)).toBeInstanceOf(BillPhotoProcessor);
  });

  it('routes GET bills/events to the event stream, not to GET bills/:id', async () => {
    const stream = await listen(alice);
    expect(stream.contentType).toMatch(/^text\/event-stream/);
    stream.close();
  });

  let failedBillId: string;

  it('parses 3 photos, the 2nd not a receipt, and reports each over SSE', async () => {
    notReceipts.add(65);
    const stream = await listen(alice);
    const photos = await Promise.all([64, 65, 66].map(photo));

    let upload = api(alice).post('bills/parse-photos');
    for (const [i, p] of photos.entries()) {
      upload = upload.attach('images', p, {
        filename: `bill-${i}.jpg`,
        contentType: 'image/jpeg',
      });
    }
    const res = await upload.expect(202);
    const batch = res.body as BillBatchResponseDto;
    expect(batch).toMatchObject({ total: 3, completed: false });
    expect(batch.items.map((i) => [i.position, i.status, i.bill_id])).toEqual([
      [0, 'queued', null],
      [1, 'queued', null],
      [2, 'queued', null],
    ]);

    const completed = await stream.waitFor(
      (e) => e.type === 'batch.completed' && ofBatch(batch.batch_id)(e),
    );
    expect(completed.data).toEqual({
      batch_id: batch.batch_id,
      total: 3,
      done: 2,
      failed: 1,
      created_by_user_id: await userId(alice),
    });

    const ofThis = stream.events.filter(ofBatch(batch.batch_id));
    const at = (position: number) =>
      ofThis
        .filter((e) => (e.data as { position?: number }).position === position)
        .map((e) => e.type);
    expect(at(0)).toEqual(['item.processing', 'item.done']);
    expect(at(1)).toEqual(['item.processing', 'item.failed']);
    expect(at(2)).toEqual(['item.processing', 'item.done']);
    // batch.completed comes last, once.
    expect(ofThis.at(-1)?.type).toBe('batch.completed');
    expect(ofThis.filter((e) => e.type === 'batch.completed')).toHaveLength(1);

    const failed = ofThis.find((e) => e.type === 'item.failed')!.data as {
      bill_id: string;
      parse_error_code: string;
      parse_error_message: string;
    };
    expect(failed).toMatchObject({
      parse_error_code: 'not_a_receipt',
      parse_error_message: NOT_A_RECEIPT_MESSAGE,
      bill_id: expect.any(String) as string,
    });
    failedBillId = failed.bill_id;

    const state = (
      await api(alice).get(`bill-batches/${batch.batch_id}`).expect(200)
    ).body as BillBatchResponseDto;
    expect(state.completed).toBe(true);
    const doneIds = ofThis
      .filter((e) => e.type === 'item.done')
      .map((e) => (e.data as { bill_id: string }).bill_id);
    expect(
      state.items.map((i) => ({
        position: i.position,
        status: i.status,
        code: i.parse_error_code,
      })),
    ).toEqual([
      { position: 0, status: 'done', code: null },
      { position: 1, status: 'failed', code: 'not_a_receipt' },
      { position: 2, status: 'done', code: null },
    ]);
    expect(state.items[1]).toMatchObject({
      bill_id: failedBillId,
      parse_error_message: NOT_A_RECEIPT_MESSAGE,
    });
    expect([state.items[0].bill_id, state.items[2].bill_id].sort()).toEqual(
      doneIds.sort(),
    );

    const drafts = (await api(alice).get('bills/drafts').expect(200)).body as {
      data: BillDetailResponseDto[];
    };
    expect(drafts.data.map((b) => b.id).sort()).toEqual(doneIds.sort());

    const failedList = (
      await api(alice).get('bills/drafts?status=failed').expect(200)
    ).body as { data: BillDetailResponseDto[]; meta: { total: number } };
    expect(failedList.meta.total).toBe(1);
    expect(failedList.data[0]).toMatchObject({
      id: failedBillId,
      status: 'failed',
      parse_error_code: 'not_a_receipt',
      parse_error_message: NOT_A_RECEIPT_MESSAGE,
    });
  });

  it('lets a failed bill be entered manually: PUT its lines, then confirm', async () => {
    const updated = (
      await api(alice)
        .put(`bills/${failedBillId}`)
        .send({
          bill_date: '2026-11-01',
          total_amount: 7.5,
          items: [{ raw_name: 'Bread', product_count: 1, amount: 7.5 }],
        })
        .expect(200)
    ).body as BillDetailResponseDto;
    expect(updated).toMatchObject({ status: 'failed', total_amount: 7.5 });
    expect(updated.items).toHaveLength(1);

    const confirmed = (
      await api(alice)
        .post(`bills/${failedBillId}/confirm`)
        .send({
          bill_date: '2026-11-01',
          total_amount: 7.5,
          items: [{ id: updated.items[0].id, product_count: 1, amount: 7.5 }],
        })
        .expect(200)
    ).body as BillDetailResponseDto;
    expect(confirmed).toMatchObject({
      id: failedBillId,
      status: 'confirmed',
      parse_error_code: null,
      parse_error_message: null,
    });

    const failedList = (
      await api(alice).get('bills/drafts?status=failed').expect(200)
    ).body as { meta: { total: number } };
    expect(failedList.meta.total).toBe(0);
  });

  it('retries a failed bill in a new batch whose item ends done', async () => {
    notReceipts.add(70);
    const stream = await listen(alice);
    const first = (
      await api(alice)
        .post('bills/parse-photos')
        .attach('images', await photo(70), {
          filename: 'bill.jpg',
          contentType: 'image/jpeg',
        })
        .expect(202)
    ).body as BillBatchResponseDto;
    const failed = await stream.waitFor(
      (e) => e.type === 'item.failed' && ofBatch(first.batch_id)(e),
    );
    const billId = (failed.data as { bill_id: string }).bill_id;

    // The AI reads the same photo this time.
    notReceipts.delete(70);
    const retried = (await api(alice).post(`bills/${billId}/retry`).expect(202))
      .body as BillBatchResponseDto;
    expect(retried.batch_id).not.toBe(first.batch_id);
    expect(retried).toMatchObject({ total: 1, completed: false });
    expect(retried.items).toEqual([
      expect.objectContaining({ position: 0, status: 'queued', bill_id: null }),
    ]);

    const done = await stream.waitFor(
      (e) => e.type === 'item.done' && ofBatch(retried.batch_id)(e),
    );
    await stream.waitFor(
      (e) => e.type === 'batch.completed' && ofBatch(retried.batch_id)(e),
    );
    const draftId = (done.data as { bill_id: string }).bill_id;
    expect(draftId).not.toBe(billId);

    const state = (
      await api(alice).get(`bill-batches/${retried.batch_id}`).expect(200)
    ).body as BillBatchResponseDto;
    expect(state).toMatchObject({ completed: true });
    expect(state.items[0]).toMatchObject({ status: 'done', bill_id: draftId });

    // The failed bill is replaced by the new draft.
    await api(alice).get(`bills/${billId}`).expect(404);
    const draft = (await api(alice).get(`bills/${draftId}`).expect(200))
      .body as BillDetailResponseDto;
    expect(draft.status).toBe('draft');
  });

  it('answers 415 when one of 2 files is not an image, storing nothing', async () => {
    const id = await userId(carol);
    const stored = storage.files.size;
    const jobs = await queuedJobs();

    const res = await api(carol)
      .post('bills/parse-photos')
      .attach('images', await photo(80), {
        filename: 'bill.jpg',
        contentType: 'image/jpeg',
      })
      .attach('images', Buffer.from('plain text'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });

    // The design said 400; the controller keeps prepareReceiptImage's 415
    // for a file that is not an image, naming its index (Task 8).
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({
      statusCode: 415,
      message: expect.stringMatching(/^File 1: /) as string,
    });
    expect(await batchRows(id)).toBe(0);
    expect(storage.files.size).toBe(stored);
    expect(await queuedJobs()).toBe(jobs);
    expect(parseAndCategorize).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      carol.householdId,
      expect.anything(),
    );
  });

  it('answers 429 when the daily AI budget is spent, queuing nothing', async () => {
    const id = await userId(carol);
    const jobs = await queuedJobs();
    jest
      .spyOn(app.get(AiGatewayService), 'assertWithinBudget')
      .mockRejectedValue(new AiBudgetExceededError(1.5, 1));

    const res = await api(carol)
      .post('bills/parse-photos')
      .attach('images', await photo(81), {
        filename: 'bill.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: expect.stringMatching(/^Daily AI budget exceeded/) as string,
      request_id: null,
    });
    expect(await batchRows(id)).toBe(0);
    expect(await queuedJobs()).toBe(jobs);
  });

  describe('a member of another household', () => {
    let batchId: string;
    let bobStream: EventStream;
    let aliceStream: EventStream;

    beforeAll(async () => {
      bobStream = await listen(bob);
      aliceStream = await listen(alice);
      batchId = (
        (
          await api(alice)
            .post('bills/parse-photos')
            .attach('images', await photo(90), {
              filename: 'bill.jpg',
              contentType: 'image/jpeg',
            })
            .expect(202)
        ).body as BillBatchResponseDto
      ).batch_id;
    });

    it('gets 404 for the batch in their own household', async () => {
      await api(bob).get(`bill-batches/${batchId}`).expect(404);
    });

    it("gets 403 for the batch through the other household's path", async () => {
      await request(app.getHttpServer())
        .get(`/households/${alice.householdId}/bill-batches/${batchId}`)
        .set('Authorization', `Bearer ${bob.accessToken}`)
        .expect(403);
    });

    it("gets 403 for the other household's event stream", async () => {
      const stream = await openEvents(
        baseUrl,
        alice.householdId,
        bob.accessToken,
      );
      streams.push(stream);
      expect(stream.status).toBe(403);
    });

    it("gets none of the other household's events on their own stream", async () => {
      await aliceStream.waitFor(
        (e) => e.type === 'batch.completed' && ofBatch(batchId)(e),
      );
      expect(aliceStream.events.filter(ofBatch(batchId))).not.toEqual([]);
      expect(bobStream.events.filter(ofBatch(batchId))).toEqual([]);
    });
  });

  describe('with a daily AI quota smaller than the batch', () => {
    let quotaApp: NestExpressApplication;
    let dave: TestUser;

    beforeAll(async () => {
      quotaApp = await createTestApp({
        override: (builder) =>
          overrides(builder)
            .overrideProvider(AI_USAGE_LIMITS)
            .useValue({
              userPerMinute: 10,
              userPerDay: 2,
              dailyBudgetUsd: 1,
              maxConcurrency: 4,
            } satisfies AiUsageLimits),
      });
      dave = await registerUser(quotaApp, 'batch-dave');
    });

    afterAll(async () => {
      await quotaApp?.close();
    });

    it('answers 429 with Retry-After and queues nothing', async () => {
      const id = await userId(dave);
      const stored = storage.files.size;
      const jobs = await queuedJobs();

      let upload = request(quotaApp.getHttpServer())
        .post(`/households/${dave.householdId}/bills/parse-photos`)
        .set('Authorization', `Bearer ${dave.accessToken}`);
      for (const w of [100, 101, 102]) {
        upload = upload.attach('images', await photo(w), {
          filename: `bill-${w}.jpg`,
          contentType: 'image/jpeg',
        });
      }
      const res = await upload;

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(res.body).toMatchObject({
        statusCode: 429,
        message: expect.stringMatching(
          /^AI request limit reached: 2 per 24 hours/,
        ) as string,
      });
      expect(await batchRows(id)).toBe(0);
      expect(storage.files.size).toBe(stored);
      expect(await queuedJobs()).toBe(jobs);
    });
  });
});
