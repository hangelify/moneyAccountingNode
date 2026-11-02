import { DelayedError, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import {
  AiBudgetExceededError,
  AiCapacityExceededError,
  AiGatewayExhaustedError,
} from '../../ai-gateway/errors';
import { BillBatchItemStatus } from '../../../types/bill-batch-item-status.enum';
import { BillParseErrorCode } from '../../../types/bill-parse-error.enum';
import type { BillBatchEnv } from './bill-batch.env';
import type { BillPhotoJob, BillPhotoJobItem } from './bill-batch.service';
import { BillPhotoProcessor } from './bill-photo.processor';

describe('BillPhotoProcessor', () => {
  const env: BillBatchEnv = { enabled: true, concurrency: 4, attempts: 3 };
  const NOW = 1_800_000_000_000;

  let item: BillPhotoJobItem;
  let batches: Record<string, jest.Mock>;
  let ingest: { ingest: jest.Mock };
  let storage: { get: jest.Mock };
  let quota: { takeMinute: jest.Mock };
  let events: { publish: jest.Mock };
  let processor: BillPhotoProcessor;

  function fakeJob(attemptsMade = 0) {
    return {
      data: { itemId: 'item-1' },
      attemptsMade,
      opts: { attempts: env.attempts },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    };
  }
  const asJob = (job: ReturnType<typeof fakeJob>) =>
    job as unknown as Job<BillPhotoJob>;

  const published = () =>
    (events.publish.mock.calls as [string, { type: string }][]).map(
      (c) => c[1].type,
    );

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    item = {
      id: 'item-1',
      batchId: 'batch-1',
      position: 2,
      status: BillBatchItemStatus.QUEUED,
      imageKey: 'ai/images/hh-1/a.jpg',
      imageSha256: 'a'.repeat(64),
      householdId: 'hh-1',
      createdById: 'user-1',
    };
    batches = {
      findItemForJob: jest.fn(() => Promise.resolve(item)),
      markItemProcessing: jest.fn().mockResolvedValue({ changed: true }),
      markItemQueued: jest.fn().mockResolvedValue({ changed: true }),
      markItemDone: jest
        .fn()
        .mockResolvedValue({ changed: true, completion: null }),
      markItemFailed: jest.fn().mockResolvedValue({
        changed: true,
        billId: 'failed-bill',
        completion: null,
      }),
    };
    ingest = { ingest: jest.fn() };
    storage = {
      get: jest.fn().mockResolvedValue({
        buffer: Buffer.from('jpeg'),
        mediaType: 'image/jpeg',
      }),
    };
    quota = {
      takeMinute: jest
        .fn()
        .mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    processor = new BillPhotoProcessor(
      batches as never,
      ingest as never,
      storage as never,
      quota as never,
      events as never,
      env,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const itemEvent = (type: string, extra: Record<string, unknown>) => [
    'hh-1',
    {
      type,
      data: {
        batch_id: 'batch-1',
        item_id: 'item-1',
        position: 2,
        created_by_user_id: 'user-1',
        ...extra,
      },
    },
  ];

  it('sets the worker concurrency from the env on bootstrap', () => {
    const worker = { concurrency: 1 };
    Object.assign(processor, { _worker: worker });
    processor.onApplicationBootstrap();
    expect(worker.concurrency).toBe(4);
  });

  it('turns a draft into a done item with its bill', async () => {
    ingest.ingest.mockResolvedValue({
      kind: 'draft',
      billId: 'draft-1',
      duplicate: false,
      requestId: 'req-1',
      parsed: {},
    });

    await processor.process(asJob(fakeJob()), 'tok');

    expect(storage.get).toHaveBeenCalledWith('ai/images/hh-1/a.jpg');
    expect(quota.takeMinute).toHaveBeenCalledWith('user-1');
    expect(ingest.ingest).toHaveBeenCalledWith({
      image: Buffer.from('jpeg'),
      mediaType: 'image/jpeg',
      imageSha256: 'a'.repeat(64),
      imageKey: 'ai/images/hh-1/a.jpg',
      householdId: 'hh-1',
      userId: 'user-1',
    });
    expect(batches.markItemProcessing).toHaveBeenCalledWith('item-1');
    expect(batches.markItemDone).toHaveBeenCalledWith('item-1', 'draft-1');
    expect(events.publish.mock.calls).toEqual([
      itemEvent('item.processing', { status: 'processing' }),
      itemEvent('item.done', { status: 'done', bill_id: 'draft-1' }),
    ]);
  });

  it('points an item at the existing open draft of the same photo', async () => {
    ingest.ingest.mockResolvedValue({
      kind: 'existing',
      billId: 'draft-old',
      parsed: {},
      requestId: null,
    });

    await processor.process(asJob(fakeJob()), 'tok');

    expect(batches.markItemDone).toHaveBeenCalledWith('item-1', 'draft-old');
    expect(events.publish).toHaveBeenLastCalledWith(
      ...itemEvent('item.done', { status: 'done', bill_id: 'draft-old' }),
    );
  });

  // Review Focus 1: two items with the same hash; the second one's save
  // races the first and answers with the first draft as a duplicate.
  it('marks a raced duplicate draft done with the draft it was given', async () => {
    ingest.ingest.mockResolvedValue({
      kind: 'draft',
      billId: 'draft-first',
      duplicate: true,
      requestId: 'req-2',
      parsed: {},
    });

    await processor.process(asJob(fakeJob()), 'tok');

    expect(batches.markItemDone).toHaveBeenCalledWith('item-1', 'draft-first');
    expect(batches.markItemFailed).not.toHaveBeenCalled();
    expect(events.publish).toHaveBeenLastCalledWith(
      ...itemEvent('item.done', { status: 'done', bill_id: 'draft-first' }),
    );
  });

  it('keeps a photo that is not a receipt as a failed bill', async () => {
    ingest.ingest.mockResolvedValue({
      kind: 'not_a_receipt',
      requestId: 'req-3',
    });

    await processor.process(asJob(fakeJob()), 'tok');

    const message =
      'The photo is not a receipt or no items were recognized on it';
    expect(batches.markItemFailed).toHaveBeenCalledWith('item-1', {
      code: BillParseErrorCode.NOT_A_RECEIPT,
      message,
      aiRequestId: 'req-3',
    });
    expect(events.publish).toHaveBeenLastCalledWith(
      ...itemEvent('item.failed', {
        status: 'failed',
        bill_id: 'failed-bill',
        parse_error_code: 'not_a_receipt',
        parse_error_message: message,
      }),
    );
  });

  it('keeps a recognized bill whose draft could not be saved as save_failed', async () => {
    ingest.ingest.mockResolvedValue({
      kind: 'save_failed',
      requestId: 'req-4',
      parsed: {},
    });

    await processor.process(asJob(fakeJob()), 'tok');

    const message =
      'The bill was recognized but the draft could not be saved; enter it manually';
    expect(batches.markItemFailed).toHaveBeenCalledWith('item-1', {
      code: BillParseErrorCode.SAVE_FAILED,
      message,
      aiRequestId: 'req-4',
    });
    expect(events.publish).toHaveBeenLastCalledWith(
      ...itemEvent('item.failed', {
        status: 'failed',
        bill_id: 'failed-bill',
        parse_error_code: 'save_failed',
        parse_error_message: message,
      }),
    );
  });

  it('delays the job over the per-minute limit and queues the item again', async () => {
    quota.takeMinute.mockResolvedValue({ allowed: false, retryAfterMs: 7000 });
    const job = fakeJob();

    await expect(processor.process(asJob(job), 'tok')).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(ingest.ingest).not.toHaveBeenCalled();
    expect(batches.markItemQueued).toHaveBeenCalledWith('item-1');
    expect(job.moveToDelayed).toHaveBeenCalledWith(NOW + 7000, 'tok');
    expect(batches.markItemFailed).not.toHaveBeenCalled();
  });

  it('delays the job by retryAfterSec when every AI slot is busy', async () => {
    ingest.ingest.mockRejectedValue(new AiCapacityExceededError(4, 3));
    const job = fakeJob();

    await expect(processor.process(asJob(job), 'tok')).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(batches.markItemQueued).toHaveBeenCalledWith('item-1');
    expect(job.moveToDelayed).toHaveBeenCalledWith(NOW + 3000, 'tok');
  });

  it('fails a job over the daily budget for good with ai_failed', async () => {
    ingest.ingest.mockRejectedValue(new AiBudgetExceededError(10, 10));
    const job = fakeJob(0);

    const err = await processor
      .process(asJob(job), 'tok')
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(UnrecoverableError);

    // BullMQ counts the attempt before emitting 'failed'.
    job.attemptsMade = 1;
    await processor.onFailed(asJob(job), err as Error);

    expect(batches.markItemFailed).toHaveBeenCalledWith('item-1', {
      code: BillParseErrorCode.AI_FAILED,
      message: 'Daily AI budget reached; retry tomorrow',
    });
    expect(events.publish).toHaveBeenLastCalledWith(
      ...itemEvent('item.failed', {
        status: 'failed',
        bill_id: 'failed-bill',
        parse_error_code: 'ai_failed',
        parse_error_message: 'Daily AI budget reached; retry tomorrow',
      }),
    );
  });

  it('rethrows a gateway error and fails the item on the last attempt', async () => {
    const gatewayErr = new AiGatewayExhaustedError('req-5', new Error('503'));
    ingest.ingest.mockRejectedValue(gatewayErr);

    await expect(processor.process(asJob(fakeJob()), 'tok')).rejects.toBe(
      gatewayErr,
    );
    await processor.onFailed(asJob(fakeJob(3)), gatewayErr);

    expect(batches.markItemFailed).toHaveBeenCalledWith('item-1', {
      code: BillParseErrorCode.AI_FAILED,
      message: 'The AI service is unavailable; retry later',
    });
  });

  it('leaves the item alone after a failure that will be retried', async () => {
    await processor.onFailed(
      asJob(fakeJob(1)),
      new AiGatewayExhaustedError('req-6', new Error('503')),
    );

    expect(batches.markItemFailed).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('says "Processing failed" for any other final error', async () => {
    await processor.onFailed(asJob(fakeJob(3)), new Error('storage down'));

    expect(batches.markItemFailed).toHaveBeenCalledWith('item-1', {
      code: BillParseErrorCode.AI_FAILED,
      message: 'Processing failed; retry later',
    });
  });

  // Review Focus 2: a re-delivered job of a finished item is a no-op.
  it('skips a job whose item is already done', async () => {
    item.status = BillBatchItemStatus.DONE;

    await processor.process(asJob(fakeJob()), 'tok');

    expect(batches.markItemProcessing).not.toHaveBeenCalled();
    expect(quota.takeMinute).not.toHaveBeenCalled();
    expect(ingest.ingest).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('skips a job whose item no longer exists', async () => {
    batches.findItemForJob.mockResolvedValue(null);

    await processor.process(asJob(fakeJob()), 'tok');

    expect(ingest.ingest).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('fails the item without calling the AI when its creator is gone', async () => {
    item.createdById = null;

    await processor.process(asJob(fakeJob()), 'tok');

    expect(quota.takeMinute).not.toHaveBeenCalled();
    expect(ingest.ingest).not.toHaveBeenCalled();
    expect(batches.markItemFailed).toHaveBeenCalledWith('item-1', {
      code: BillParseErrorCode.AI_FAILED,
      message: 'Processing failed; retry later',
    });
    expect(published()).toEqual(['item.failed']);
    expect(
      (events.publish.mock.calls as [string, { data: object }][])[0][1].data,
    ).toMatchObject({ created_by_user_id: null });
  });

  it('publishes batch.completed once, after the last item', async () => {
    ingest.ingest.mockResolvedValue({
      kind: 'draft',
      billId: 'draft-1',
      duplicate: false,
      requestId: 'req-1',
      parsed: {},
    });
    batches.markItemDone.mockResolvedValue({
      changed: true,
      completion: { total: 3, done: 2, failed: 1 },
    });

    await processor.process(asJob(fakeJob()), 'tok');

    expect(published()).toEqual([
      'item.processing',
      'item.done',
      'batch.completed',
    ]);
    expect(events.publish).toHaveBeenLastCalledWith('hh-1', {
      type: 'batch.completed',
      data: {
        batch_id: 'batch-1',
        total: 3,
        done: 2,
        failed: 1,
        created_by_user_id: 'user-1',
      },
    });
  });

  it('publishes batch.completed after a failed last item', async () => {
    ingest.ingest.mockResolvedValue({ kind: 'not_a_receipt', requestId: 'r' });
    batches.markItemFailed.mockResolvedValue({
      changed: true,
      billId: 'failed-bill',
      completion: { total: 1, done: 0, failed: 1 },
    });

    await processor.process(asJob(fakeJob()), 'tok');

    expect(published()).toEqual([
      'item.processing',
      'item.failed',
      'batch.completed',
    ]);
  });

  it('publishes nothing more when another call already finished the item', async () => {
    ingest.ingest.mockResolvedValue({
      kind: 'draft',
      billId: 'draft-1',
      duplicate: false,
      requestId: 'req-1',
      parsed: {},
    });
    // A finished item never reports completion; see BillBatchService.
    batches.markItemDone.mockResolvedValue({
      changed: false,
      completion: null,
    });

    await processor.process(asJob(fakeJob()), 'tok');

    expect(published()).toEqual(['item.processing']);
  });
});
