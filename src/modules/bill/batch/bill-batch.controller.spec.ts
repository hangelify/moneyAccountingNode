import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import type { INestApplication, MessageEvent } from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { createHash } from 'node:crypto';
import { Subject } from 'rxjs';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types';
import { BillBatchController } from './bill-batch.controller';
import {
  BillBatchDisabledFilter,
  BillBatchEnabledGuard,
} from './bill-batch-disabled';
import { BILL_BATCH_DISABLED } from './bill-batch.env';
import {
  BillBatchService,
  BillQuotaExceededException,
} from './bill-batch.service';
import { BillEventsHub } from './bill-events.hub';
import type { BillEvent } from './bill-events.types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from '../../household/guards/household-member.guard';
import { UserThrottlerGuard } from '../../ai-gateway/guards/user-throttler.guard';
import { AiGatewayErrorFilter } from '../filters/ai-gateway-error.filter';
import { AiUsageLimitFilter } from '../filters/ai-usage-limit.filter';
import { AiHttpExceptionFilter } from '../filters/ai-http-exception.filter';
import { BillBatchItemStatus } from '../../../types/bill-batch-item-status.enum';

const HID = '11111111-1111-4111-8111-111111111111';
const BILL_ID = '22222222-2222-4222-8222-222222222222';

function jpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 30, channels: 3, background: '#fff' },
  })
    .jpeg()
    .toBuffer();
}

const batch = {
  batch_id: '33333333-3333-4333-8333-333333333333',
  created_at: '2026-11-02T10:00:00.000Z',
  total: 1,
  completed: false,
  items: [],
};

describe('BillBatchController', () => {
  const createBatch = jest.fn();
  const getBatch = jest.fn();
  const retry = jest.fn();
  const hubEvents = new Subject<BillEvent>();
  const stream = jest.fn(() => hubEvents.asObservable());

  async function build(enabled: boolean) {
    const builder = Test.createTestingModule({
      controllers: [BillBatchController],
      providers: enabled
        ? [
            {
              provide: BillBatchService,
              useValue: { createBatch, getBatch, retry },
            },
            { provide: BillEventsHub, useValue: { stream } },
          ]
        : [{ provide: BILL_BATCH_DISABLED, useValue: true }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp(): { getRequest(): Record<string, unknown> };
        }) => {
          ctx.switchToHttp().getRequest().user = { id: 'user-1', exp: 0 };
          return true;
        },
      })
      .overrideGuard(HouseholdMemberGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp(): { getRequest(): Record<string, unknown> };
        }) => {
          ctx.switchToHttp().getRequest().household = {
            householdId: HID,
            role: 'owner',
          };
          return true;
        },
      })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true });
    const mod = await builder.compile();
    const app = mod.createNestApplication<INestApplication<App>>({
      logger: false,
    });
    await app.init();
    return app;
  }

  beforeEach(() => {
    [createBatch, getBatch, retry, stream].forEach((fn) => fn.mockClear());
    createBatch.mockResolvedValue(batch);
    getBatch.mockResolvedValue(batch);
    retry.mockResolvedValue(batch);
  });

  describe('when enabled', () => {
    let app: INestApplication<App>;
    beforeAll(async () => {
      app = await build(true);
    });
    afterAll(async () => {
      await app.close();
    });

    it('queues every photo, prepared and hashed in order, and answers 202', async () => {
      const res = await request(app.getHttpServer())
        .post(`/households/${HID}/bills/parse-photos`)
        .attach('images', await jpeg(), 'a.jpg')
        .attach('images', await jpeg(), 'b.jpg')
        .expect(202);

      expect(res.body).toEqual(batch);
      const [[args]] = createBatch.mock.calls as [
        [
          {
            householdId: string;
            userId: string;
            images: { buffer: Buffer; mediaType: string; sha256: string }[];
          },
        ],
      ];
      expect(args.householdId).toBe(HID);
      expect(args.userId).toBe('user-1');
      expect(args.images).toHaveLength(2);
      for (const image of args.images) {
        expect(image.mediaType).toBe('image/jpeg');
        expect(image.sha256).toBe(
          createHash('sha256').update(image.buffer).digest('hex'),
        );
      }
    });

    it('answers 400 for a request without files', async () => {
      const res = await request(app.getHttpServer())
        .post(`/households/${HID}/bills/parse-photos`)
        .set('Content-Type', 'multipart/form-data; boundary=x')
        .send('--x--\r\n')
        .expect(400);
      expect(res.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'At least one image is required',
        request_id: null,
      });
      expect(createBatch).not.toHaveBeenCalled();
    });

    it('rejects 21 files in multer, before any is prepared', async () => {
      let req = request(app.getHttpServer()).post(
        `/households/${HID}/bills/parse-photos`,
      );
      const image = await jpeg();
      for (let i = 0; i < 21; i++) {
        req = req.attach('images', image, `${i}.jpg`);
      }
      const res = await req.expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, request_id: null });
      expect(createBatch).not.toHaveBeenCalled();
    });

    it('refuses extra fields', async () => {
      await request(app.getHttpServer())
        .post(`/households/${HID}/bills/parse-photos`)
        .field('note', 'x')
        .attach('images', await jpeg(), 'a.jpg')
        .expect(400);
      expect(createBatch).not.toHaveBeenCalled();
    });

    it('names the 0-based index of an undecodable file and stores nothing', async () => {
      const res = await request(app.getHttpServer())
        .post(`/households/${HID}/bills/parse-photos`)
        .attach('images', await jpeg(), 'a.jpg')
        // A JPEG header with a broken body.
        .attach(
          'images',
          Buffer.concat([
            Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
            Buffer.alloc(64, 1),
          ]),
          'b.jpg',
        )
        .expect(400);
      expect(res.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'File 1: The image could not be decoded',
        request_id: null,
      });
      expect(createBatch).not.toHaveBeenCalled();
    });

    it('keeps 415 for a file that is not an image, with its index', async () => {
      const res = await request(app.getHttpServer())
        .post(`/households/${HID}/bills/parse-photos`)
        .attach('images', Buffer.from('plain text'), 'a.txt')
        .expect(415);
      expect(res.body).toMatchObject({
        message: 'File 0: The image must be a JPEG, PNG or WebP file',
        request_id: null,
      });
      expect(createBatch).not.toHaveBeenCalled();
    });

    it('sets Retry-After when the daily quota cannot cover the batch', async () => {
      createBatch.mockRejectedValueOnce(
        new BillQuotaExceededException(50, 120),
      );
      const res = await request(app.getHttpServer())
        .post(`/households/${HID}/bills/parse-photos`)
        .attach('images', await jpeg(), 'a.jpg')
        .expect(429);
      expect(res.headers['retry-after']).toBe('120');
      expect(res.body).toEqual({
        statusCode: 429,
        error: 'Too Many Requests',
        message:
          'AI request limit reached: 50 per 24 hours. Try again in 120 s.',
        request_id: null,
      });
    });

    it('answers a batch of the household', async () => {
      await request(app.getHttpServer())
        .get(`/households/${HID}/bill-batches/${batch.batch_id}`)
        .expect(200, batch);
      expect(getBatch).toHaveBeenCalledWith(HID, batch.batch_id);
    });

    it('answers 400 for a batch id that is not a UUID', async () => {
      await request(app.getHttpServer())
        .get(`/households/${HID}/bill-batches/abc`)
        .expect(400);
      expect(getBatch).not.toHaveBeenCalled();
    });

    it('retries a failed bill with 202 and sets Retry-After on a quota refusal', async () => {
      await request(app.getHttpServer())
        .post(`/households/${HID}/bills/${BILL_ID}/retry`)
        .expect(202, batch);
      expect(retry).toHaveBeenCalledWith(HID, 'user-1', BILL_ID);

      retry.mockRejectedValueOnce(new BillQuotaExceededException(50, 30));
      const res = await request(app.getHttpServer())
        .post(`/households/${HID}/bills/${BILL_ID}/retry`)
        .expect(429);
      expect(res.headers['retry-after']).toBe('30');
    });
  });

  describe('route metadata', () => {
    it('throttles parse-photos and retry per user after the batch switch', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, BillBatchController)).toEqual(
        [JwtAuthGuard, HouseholdMemberGuard, BillBatchEnabledGuard],
      );
      for (const name of ['parsePhotos', 'retry'] as const) {
        const handler = Object.getOwnPropertyDescriptor(
          BillBatchController.prototype,
          name,
        )!.value as object;
        expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
          UserThrottlerGuard,
        ]);
        expect(
          Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, BillBatchController),
        ).toEqual([BillBatchDisabledFilter]);
        expect(
          Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, handler),
        ).toEqual([
          AiGatewayErrorFilter,
          AiUsageLimitFilter,
          AiHttpExceptionFilter,
        ]);
      }
    });
  });

  describe('events stream', () => {
    let controller: BillBatchController;
    const setHeader = jest.fn();

    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-11-02T10:00:00Z') });
      setHeader.mockClear();
      controller = new BillBatchController(
        {} as BillBatchService,
        { stream } as unknown as BillEventsHub,
      );
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('relays household events, pings every 25 s and completes at the token exp', () => {
      const exp = Date.now() / 1000 + 60;
      const seen: MessageEvent[] = [];
      let completed = false;
      controller
        .events(
          { id: 'user-1', exp } as never,
          { householdId: HID, role: 'member' },
          { setHeader } as never,
        )
        .subscribe({
          next: (e) => seen.push(e),
          complete: () => (completed = true),
        });

      expect(stream).toHaveBeenCalledWith(HID);
      expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');

      const data = {
        batch_id: 'b',
        item_id: 'i',
        position: 0,
        status: BillBatchItemStatus.PROCESSING,
        created_by_user_id: 'user-1',
      };
      hubEvents.next({ type: 'item.processing', data });
      expect(seen).toEqual([
        { type: 'item.processing', data, id: expect.any(String) as string },
      ]);

      jest.advanceTimersByTime(25_000);
      expect(seen[1]).toEqual({ type: 'ping', data: '' });
      jest.advanceTimersByTime(25_000);
      expect(seen).toHaveLength(3);
      expect(completed).toBe(false);

      jest.advanceTimersByTime(10_000);
      expect(completed).toBe(true);
      // The hub subscription is released.
      expect(hubEvents.observed).toBe(false);
    });
  });

  describe('when disabled', () => {
    let app: INestApplication<App>;
    beforeAll(async () => {
      app = await build(false);
    });
    afterAll(async () => {
      await app.close();
    });

    it.each([
      ['post', `/households/${HID}/bills/parse-photos`],
      ['get', `/households/${HID}/bill-batches/${batch.batch_id}`],
      ['post', `/households/${HID}/bills/${BILL_ID}/retry`],
      ['get', `/households/${HID}/bills/events`],
    ] as const)(
      '%s %s answers 503 without logging an error',
      async (method, path) => {
        const logError = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        const res = await request(app.getHttpServer())
          [method](path)
          .expect(503);
        expect(res.body).toEqual({
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'Batch photo parsing is disabled',
          request_id: null,
        });
        expect(logError).not.toHaveBeenCalled();
        logError.mockRestore();
      },
    );

    it('answers 503 from the handler too when the services are absent', () => {
      const controller = new BillBatchController(undefined, undefined);
      expect(() =>
        controller.events(
          { id: 'u', exp: 0 } as never,
          { householdId: HID, role: 'owner' },
          { setHeader: jest.fn() } as never,
        ),
      ).toThrow('Batch photo parsing is disabled');
    });
  });
});
