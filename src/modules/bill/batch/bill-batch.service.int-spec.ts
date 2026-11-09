import { randomUUID } from 'node:crypto';
import { MikroORM, EntityManager, LockMode } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Bill } from '../../../entities/bill.entity';
import { BillBatch } from '../../../entities/bill-batch.entity';
import { BillBatchItem } from '../../../entities/bill-batch-item.entity';
import { Household } from '../../../entities/household.entity';
import { Market } from '../../../entities/market.entity';
import { SubCategory } from '../../../entities/sub-category.entity';
import { User } from '../../../entities/user.entity';
import { BillStatus } from '../../../types/bill-status.enum';
import { BillParseErrorCode } from '../../../types/bill-parse-error.enum';
import { BillBatchItemStatus } from '../../../types/bill-batch-item-status.enum';
import { Currency } from '../../../types/currency.enum';
import { MarketService } from '../../market/market.service';
import { BillCrudService } from '../bill-crud.service';
import { BillDuplicatesService } from '../bill-duplicates.service';
import { BillConversionService } from '../household-conversion';
import { ExchangeRateService } from '../../exchange-rate/exchange-rate.service';
import { StubProvider } from '../../exchange-rate/testing/stub-exchange-rate.provider';
import {
  BillBatchService,
  BillQuotaExceededException,
  DUPLICATE_PHOTO_DELAY_MS,
  PROCESSING_FAILED_MESSAGE,
  QUEUE_FAILED_MESSAGE,
} from './bill-batch.service';
import type { BillBatchEnv } from './bill-batch.env';

jest.setTimeout(30_000);

// BillBatchService against the real PostgreSQL schema; the queue, storage,
// quota and events are fakes.
describe('BillBatchService (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  let householdId: string;
  let otherHouseholdId: string;

  const env: BillBatchEnv = {
    enabled: true,
    concurrency: 2,
    attempts: 3,
    maxConcurrentUploads: 2,
  };
  let queue: { addBulk: jest.Mock; getJob: jest.Mock };
  let storage: { put: jest.Mock };
  let quota: { reserveDaily: jest.Mock };
  let gateway: { assertWithinBudget: jest.Mock };
  let publisher: { publish: jest.Mock };
  let service: BillBatchService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: PostgreSqlDriver,
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432', 10),
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
          dbName: process.env.DB_NAME || 'accounting',
          entities: ['./dist/**/*.entity.js'],
          entitiesTs: ['./src/**/*.entity.ts'],
          allowGlobalContext: true,
        }),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    const em = orm.em.fork();
    const user = em.create(User, {
      first_name: 'Batch',
      email: `batch-${randomUUID()}@example.com`,
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Batch household',
      currency: Currency.EUR,
      created_by: user,
    } as never);
    const other = em.create(Household, {
      name: 'Batch other',
      currency: Currency.EUR,
      created_by: user,
    } as never);
    await em.flush();
    userId = user.id;
    householdId = household.id;
    otherHouseholdId = other.id;
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = orm.em.getConnection();
    const hids = [householdId, otherHouseholdId];
    await conn.execute(
      'DELETE FROM bill_batches WHERE household_id IN (?, ?)',
      hids,
    );
    await conn.execute('DELETE FROM bills WHERE household_id IN (?, ?)', hids);
    await conn.execute('DELETE FROM households WHERE id IN (?, ?)', hids);
    await conn.execute('DELETE FROM users WHERE id = ?', [userId]);
    await orm.close(true);
  });

  function crud(fork: EntityManager = orm.em.fork()) {
    const rates = new ExchangeRateService(fork, new StubProvider());
    return new BillCrudService(
      fork.getRepository(Bill),
      fork.getRepository(Market),
      fork.getRepository(SubCategory),
      fork,
      rates,
      new BillConversionService(fork, rates),
      new BillDuplicatesService(fork),
      new MarketService(fork.getRepository(Market), fork),
    );
  }

  beforeEach(() => {
    queue = {
      addBulk: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      put: jest.fn((_buf: Buffer, _type: string, hid: string) =>
        Promise.resolve({ key: `ai/images/${hid}/${randomUUID()}.jpg` }),
      ),
    };
    quota = {
      reserveDaily: jest
        .fn()
        .mockResolvedValue({ allowed: true, retryAfterSec: 0 }),
    };
    gateway = { assertWithinBudget: jest.fn().mockResolvedValue(undefined) };
    publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new BillBatchService(
      orm.em,
      crud(),
      storage as never,
      quota as never,
      gateway as never,
      { userPerDay: 100 } as never,
      queue as never,
      publisher as never,
      env,
    );
  });

  const images = (n: number) =>
    Array.from({ length: n }, () => ({
      buffer: Buffer.from(randomUUID()),
      mediaType: 'image/jpeg' as const,
      sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
    }));

  async function itemsOf(batchId: string) {
    return orm.em
      .fork()
      .find(
        BillBatchItem,
        { batch: batchId },
        { orderBy: { position: 'asc' }, populate: ['bill'] },
      );
  }

  async function makeBill(status: BillStatus, imageKey?: string) {
    const em = orm.em.fork();
    const bill = em.create(Bill, {
      household: householdId,
      created_by: userId,
      status,
      bill_date: '2026-11-02',
      amount: 0,
      bill_date_inferred: true,
      image_key: imageKey,
      image_sha256: imageKey ? 'f'.repeat(64) : undefined,
      ...(status === BillStatus.FAILED
        ? {
            parse_error_code: BillParseErrorCode.AI_FAILED,
            parse_error_message: 'Processing failed; retry later',
          }
        : {}),
    } as never);
    await em.flush();
    return bill.id;
  }

  describe('createBatch', () => {
    it('stores the items queued in upload order and enqueues one job each', async () => {
      const imgs = images(3);
      const res = await service.createBatch({
        householdId,
        userId,
        images: imgs,
      });

      expect(quota.reserveDaily).toHaveBeenCalledWith(userId, 2);
      expect(gateway.assertWithinBudget).toHaveBeenCalledWith(userId);
      expect(res.total).toBe(3);
      expect(res.completed).toBe(false);
      expect(res.items.map((i) => [i.position, i.status, i.bill_id])).toEqual([
        [0, 'queued', null],
        [1, 'queued', null],
        [2, 'queued', null],
      ]);

      const stored = await itemsOf(res.batch_id);
      expect(stored.map((i) => i.image_sha256)).toEqual(
        imgs.map((i) => i.sha256),
      );
      expect(stored.map((i) => i.id)).toEqual(res.items.map((i) => i.id));

      expect(queue.addBulk).toHaveBeenCalledTimes(1);
      const jobs = (queue.addBulk.mock.calls as unknown[][])[0][0] as {
        data: { itemId: string };
        opts: Record<string, unknown>;
      }[];
      expect(jobs.map((j) => j.data.itemId)).toEqual(stored.map((i) => i.id));
      expect(jobs[0].opts).toEqual({
        jobId: stored[0].id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 86400 },
      });
    });

    it('refuses over the daily quota before storing anything', async () => {
      quota.reserveDaily.mockResolvedValue({
        allowed: false,
        retryAfterSec: 42,
      });
      const before = await orm.em
        .fork()
        .count(BillBatch, { household: householdId });

      const err = await service
        .createBatch({ householdId, userId, images: images(2) })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ThrottlerException);
      expect(err).toBeInstanceOf(BillQuotaExceededException);
      expect((err as BillQuotaExceededException).retryAfterSec).toBe(42);
      expect((err as Error).message).toBe(
        'AI request limit reached: 100 per 24 hours. Try again in 42 s.',
      );
      expect(storage.put).not.toHaveBeenCalled();
      expect(queue.addBulk).not.toHaveBeenCalled();
      expect(
        await orm.em.fork().count(BillBatch, { household: householdId }),
      ).toBe(before);
    });

    it('delays the job of a photo repeated in the upload', async () => {
      const [a, b] = images(2);
      await service.createBatch({ householdId, userId, images: [a, b, a, a] });

      const jobs = (queue.addBulk.mock.calls as unknown[][])[0][0] as {
        opts: { delay?: number };
      }[];
      expect(jobs.map((j) => j.opts.delay)).toEqual([
        undefined,
        undefined,
        DUPLICATE_PHOTO_DELAY_MS,
        DUPLICATE_PHOTO_DELAY_MS,
      ]);
    });

    it('checks the budget before reserving, so a budget refusal costs no quota', async () => {
      gateway.assertWithinBudget.mockRejectedValue(new Error('over budget'));

      await expect(
        service.createBatch({ householdId, userId, images: images(2) }),
      ).rejects.toThrow('over budget');

      expect(quota.reserveDaily).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('fails every item when the jobs cannot be queued', async () => {
      queue.addBulk.mockRejectedValue(new Error('redis down'));

      const res = await service.createBatch({
        householdId,
        userId,
        images: images(2),
      });

      expect(res.completed).toBe(true);
      for (const item of res.items) {
        expect(item.status).toBe('failed');
        expect(item.parse_error_code).toBe('ai_failed');
        expect(item.parse_error_message).toBe(QUEUE_FAILED_MESSAGE);
        expect(item.bill_id).toEqual(expect.any(String));
      }
      expect(QUEUE_FAILED_MESSAGE).toBe(
        'The photo could not be queued; retry later',
      );
      const bills = await orm.em.fork().find(Bill, {
        id: { $in: res.items.map((i) => i.bill_id!) },
      });
      expect(bills.map((b) => b.status)).toEqual([
        BillStatus.FAILED,
        BillStatus.FAILED,
      ]);
      const types = (
        publisher.publish.mock.calls as [string, { type: string }][]
      ).map((c) => c[1].type);
      expect(types).toEqual(['item.failed', 'item.failed', 'batch.completed']);
    });
  });

  describe('item transitions', () => {
    it('marks an item failed once, with one failed bill', async () => {
      const res = await service.createBatch({
        householdId,
        userId,
        images: images(2),
      });
      const [first, second] = res.items;

      const a = await service.markItemFailed(first.id, {
        code: BillParseErrorCode.NOT_A_RECEIPT,
        message: 'not a receipt',
      });
      const b = await service.markItemFailed(first.id, {
        code: BillParseErrorCode.AI_FAILED,
        message: 'again',
      });

      expect(a.changed).toBe(true);
      expect(typeof a.billId).toBe('string');
      // The second item still runs.
      expect(a.completion).toBeNull();
      expect(b).toEqual({ changed: false, billId: a.billId, completion: null });
      const [stored] = await itemsOf(res.batch_id);
      expect(stored.status).toBe(BillBatchItemStatus.FAILED);
      const bills = await orm.em
        .fork()
        .find(Bill, { image_sha256: stored.image_sha256 });
      expect(bills).toHaveLength(1);
      expect(bills[0].parse_error_code).toBe(BillParseErrorCode.NOT_A_RECEIPT);
      expect(bills[0].image_key).toBe(stored.image_key);

      // A finished item cannot become done, and the batch is still running.
      expect(await service.markItemDone(first.id, a.billId!)).toEqual({
        changed: false,
        completion: null,
      });

      await service.markItemProcessing(second.id);
      expect((await itemsOf(res.batch_id))[1].status).toBe(
        BillBatchItemStatus.PROCESSING,
      );
      await service.markItemQueued(second.id);
      expect((await itemsOf(res.batch_id))[1].status).toBe(
        BillBatchItemStatus.QUEUED,
      );
      const draftId = await makeBill(BillStatus.DRAFT);
      expect(await service.markItemDone(second.id, draftId)).toEqual({
        changed: true,
        completion: { total: 2, done: 1, failed: 1 },
      });

      const batch = await service.getBatch(householdId, res.batch_id);
      expect(batch.completed).toBe(true);
      expect(batch.items[1]).toMatchObject({
        status: 'done',
        bill_id: draftId,
        parse_error_code: null,
      });
    });

    it('reports completion to exactly one of two items finishing at once', async () => {
      const res = await service.createBatch({
        householdId,
        userId,
        images: images(2),
      });
      const [d1, d2] = [
        await makeBill(BillStatus.DRAFT),
        await makeBill(BillStatus.DRAFT),
      ];

      // Hold both item rows so the two calls start together, each in its own
      // fork and transaction, once the rows are released.
      const holder = orm.em.fork();
      await holder.begin();
      await holder.find(
        BillBatchItem,
        { id: { $in: res.items.map((i) => i.id) } },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      const pending = Promise.all([
        service.markItemDone(res.items[0].id, d1),
        service.markItemDone(res.items[1].id, d2),
      ]);
      await new Promise((r) => setTimeout(r, 300));
      await holder.commit();
      const results = await pending;

      expect(results.map((r) => r.changed)).toEqual([true, true]);
      const completions = results
        .map((r) => r.completion)
        .filter((c) => c !== null);
      expect(completions).toEqual([{ total: 2, done: 2, failed: 0 }]);
    });

    it('loads an item with its batch household and creator for a job', async () => {
      const res = await service.createBatch({
        householdId,
        userId,
        images: images(2),
      });
      const second = (await itemsOf(res.batch_id))[1];

      expect(await service.findItemForJob(second.id)).toEqual({
        id: second.id,
        batchId: res.batch_id,
        position: 1,
        status: BillBatchItemStatus.QUEUED,
        imageKey: second.image_key,
        imageSha256: second.image_sha256,
        householdId,
        createdById: userId,
      });
      expect(await service.findItemForJob(randomUUID())).toBeNull();
    });

    it('keeps a given bill instead of creating one', async () => {
      const res = await service.createBatch({
        householdId,
        userId,
        images: images(1),
      });
      const billId = await makeBill(BillStatus.FAILED, 'ai/images/x.jpg');
      expect(
        await service.markItemFailed(res.items[0].id, {
          code: BillParseErrorCode.SAVE_FAILED,
          message: 'save failed',
          billId,
        }),
      ).toEqual({
        changed: true,
        billId,
        completion: { total: 1, done: 0, failed: 1 },
      });
    });
  });

  describe('sweepStaleItems', () => {
    const MIN = 60_000;

    async function batchAged(n: number, ageMs: number) {
      const res = await service.createBatch({
        householdId,
        userId,
        images: images(n),
      });
      await orm.em
        .fork()
        .nativeUpdate(
          BillBatchItem,
          { batch: res.batch_id },
          { updated_at: new Date(Date.now() - ageMs) },
        );
      publisher.publish.mockClear();
      return res;
    }

    const jobIn = (state: string) => ({
      getState: jest.fn().mockResolvedValue(state),
    });

    it('fails a stale item whose job is gone, with a failed bill and events', async () => {
      const res = await batchAged(1, 20 * MIN);
      const [item] = res.items;
      await orm.em
        .fork()
        .nativeUpdate(
          BillBatchItem,
          { id: item.id },
          { status: BillBatchItemStatus.PROCESSING },
        );

      expect(await service.sweepStaleItems()).toBeGreaterThanOrEqual(1);

      expect(queue.getJob).toHaveBeenCalledWith(item.id);
      const [stored] = await itemsOf(res.batch_id);
      expect(stored.status).toBe(BillBatchItemStatus.FAILED);
      expect(stored.updated_at.getTime()).toBeGreaterThan(Date.now() - MIN);
      expect(stored.bill?.status).toBe(BillStatus.FAILED);
      expect(stored.bill?.parse_error_code).toBe(BillParseErrorCode.AI_FAILED);
      expect(stored.bill?.parse_error_message).toBe(PROCESSING_FAILED_MESSAGE);
      const events = (
        publisher.publish.mock.calls as [
          string,
          { type: string; data: { batch_id: string } },
        ][]
      ).filter((c) => c[1].data.batch_id === res.batch_id);
      expect(events.map((c) => [c[0], c[1].type])).toEqual([
        [householdId, 'item.failed'],
        [householdId, 'batch.completed'],
      ]);
    });

    it('fails a stale item whose job already failed or completed', async () => {
      const res = await batchAged(2, 20 * MIN);
      queue.getJob.mockImplementation((id: string) =>
        Promise.resolve(jobIn(id === res.items[0].id ? 'failed' : 'completed')),
      );

      await service.sweepStaleItems();

      expect((await itemsOf(res.batch_id)).map((i) => i.status)).toEqual([
        BillBatchItemStatus.FAILED,
        BillBatchItemStatus.FAILED,
      ]);
    });

    it.each(['waiting', 'delayed', 'active', 'prioritized'])(
      'leaves a stale item whose job is %s',
      async (state) => {
        const res = await batchAged(1, 20 * MIN);
        queue.getJob.mockResolvedValue(jobIn(state));

        await service.sweepStaleItems();

        const [stored] = await itemsOf(res.batch_id);
        expect(stored.status).toBe(BillBatchItemStatus.QUEUED);
        expect(stored.bill).toBeNull();
      },
    );

    it('leaves an item updated within the last 15 minutes', async () => {
      const res = await batchAged(1, 5 * MIN);

      await service.sweepStaleItems();

      expect(queue.getJob).not.toHaveBeenCalledWith(res.items[0].id);
      const [stored] = await itemsOf(res.batch_id);
      expect(stored.status).toBe(BillBatchItemStatus.QUEUED);
    });
  });

  describe('getBatch', () => {
    it('answers 404 outside the household', async () => {
      const res = await service.createBatch({
        householdId,
        userId,
        images: images(1),
      });
      await expect(
        service.getBatch(otherHouseholdId, res.batch_id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('retry', () => {
    it('refuses a bill that is not failed', async () => {
      const id = await makeBill(BillStatus.DRAFT);
      await expect(
        service.retry(householdId, userId, id),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queue.addBulk).not.toHaveBeenCalled();
    });

    it('answers 404 for a bill of another household', async () => {
      const id = await makeBill(BillStatus.FAILED, 'ai/images/y.jpg');
      await expect(
        service.retry(otherHouseholdId, userId, id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('soft-deletes the failed bill and queues its image again', async () => {
      const key = `ai/images/${householdId}/${randomUUID()}.jpg`;
      const id = await makeBill(BillStatus.FAILED, key);

      const res = await service.retry(householdId, userId, id);

      expect(quota.reserveDaily).toHaveBeenCalledWith(userId, 0);
      expect(gateway.assertWithinBudget).toHaveBeenCalledWith(userId);
      expect(res.total).toBe(1);
      expect(res.items[0].status).toBe('queued');
      const [item] = await itemsOf(res.batch_id);
      expect(item.image_key).toBe(key);
      expect(queue.addBulk).toHaveBeenCalledWith([
        expect.objectContaining({ data: { itemId: item.id } }),
      ]);
      const old = await orm.em.fork().findOneOrFail(Bill, id);
      expect(old.deleted_at).toBeInstanceOf(Date);

      // Deleting it while the retry runs no longer finds it; the item stays.
      await expect(crud().softDeleteBill(id, householdId)).rejects.toThrow(
        NotFoundException,
      );
      expect((await itemsOf(res.batch_id))[0].status).toBe(
        BillBatchItemStatus.QUEUED,
      );
      // A second retry of the same bill is refused.
      await expect(
        service.retry(householdId, userId, id),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
