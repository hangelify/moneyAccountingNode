import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { BillBatchItemStatus } from '../../../types/bill-batch-item-status.enum';
import { BillParseErrorCode } from '../../../types/bill-parse-error.enum';
import {
  AiBudgetExceededError,
  AiCapacityExceededError,
  AiGatewayExhaustedError,
} from '../../ai-gateway/errors';
import { AiUserQuota } from '../../ai-gateway/ai-user-quota.service';
import { STORAGE_SERVICE } from '../../storage/storage.service';
import type { StorageService } from '../../storage/storage.service';
import { BillPhotoIngestService } from '../bill-photo-ingest.service';
import type { IngestResult } from '../bill-photo-ingest.service';
import { BILL_BATCH_ENV, BILL_PHOTO_QUEUE } from './bill-batch.env';
import type { BillBatchEnv } from './bill-batch.env';
import { BillBatchService } from './bill-batch.service';
import type {
  BatchCompletion,
  BillPhotoJob,
  BillPhotoJobItem,
} from './bill-batch.service';
import { BillEventsPublisher } from './bill-events.publisher';
import type { ItemEvent } from './bill-events.types';

const NOT_A_RECEIPT_MESSAGE =
  'The photo is not a receipt or no items were recognized on it';
const SAVE_FAILED_MESSAGE =
  'The bill was recognized but the draft could not be saved; enter it manually';
const BUDGET_MESSAGE = 'Daily AI budget reached; retry tomorrow';
const UNAVAILABLE_MESSAGE = 'The AI service is unavailable; retry later';
const PROCESSING_FAILED_MESSAGE = 'Processing failed; retry later';

const FINISHED = [BillBatchItemStatus.DONE, BillBatchItemStatus.FAILED];

/** The `ai_failed` message for the error that ended a job. */
function failureMessage(err: Error): string {
  // A budget error is wrapped in UnrecoverableError by process().
  const cause = err instanceof UnrecoverableError ? (err.cause ?? err) : err;
  if (cause instanceof AiBudgetExceededError) return BUDGET_MESSAGE;
  if (cause instanceof AiGatewayExhaustedError) return UNAVAILABLE_MESSAGE;
  return PROCESSING_FAILED_MESSAGE;
}

/**
 * Parses one queued batch photo into a draft or a failed bill. Rate limits
 * delay the job without using an attempt; other errors are retried by BullMQ
 * and the last one becomes an `ai_failed` bill in `onFailed`.
 */
// Concurrency comes from the env in onApplicationBootstrap: the decorator runs
// at import time, before the env is known to be loaded.
@Processor(BILL_PHOTO_QUEUE)
export class BillPhotoProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly log = new Logger(BillPhotoProcessor.name);

  constructor(
    private readonly batches: BillBatchService,
    private readonly ingest: BillPhotoIngestService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly quota: AiUserQuota,
    private readonly events: BillEventsPublisher,
    @Inject(BILL_BATCH_ENV) private readonly env: BillBatchEnv,
  ) {
    super();
  }

  // After every onModuleInit, so BullModule has created the worker.
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.env.concurrency;
  }

  async process(job: Job<BillPhotoJob>, token?: string): Promise<void> {
    const item = await this.batches.findItemForJob(job.data.itemId);
    // A re-delivered job of a finished item does nothing.
    if (!item || FINISHED.includes(item.status)) return;
    const userId = item.createdById;
    if (!userId) {
      // The uploader's account is gone: nobody to bill the AI call to.
      await this.fail(
        item,
        BillParseErrorCode.AI_FAILED,
        PROCESSING_FAILED_MESSAGE,
      );
      return;
    }

    if (!(await this.batches.markItemProcessing(item.id)).changed) return;
    await this.publishItem(item, 'item.processing', {
      status: BillBatchItemStatus.PROCESSING,
    });

    const minute = await this.quota.takeMinute(userId);
    if (!minute.allowed) {
      return this.delay(job, token, item, minute.retryAfterMs);
    }

    let result: IngestResult;
    try {
      const { buffer, mediaType } = await this.storage.get(item.imageKey);
      result = await this.ingest.ingest({
        image: buffer,
        mediaType,
        imageSha256: item.imageSha256,
        imageKey: item.imageKey,
        householdId: item.householdId,
        userId,
      });
    } catch (err) {
      if (err instanceof AiCapacityExceededError) {
        return this.delay(job, token, item, err.retryAfterSec * 1000);
      }
      if (err instanceof AiBudgetExceededError) {
        // Its constructor takes no options; onFailed reads the cause.
        throw Object.assign(new UnrecoverableError(err.message), {
          cause: err,
        });
      }
      throw err;
    }
    await this.record(item, result);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<BillPhotoJob> | undefined,
    err: Error,
  ): Promise<void> {
    if (!job) return;
    // BullMQ counts the failed attempt before emitting 'failed'.
    const attempts = job.opts.attempts ?? this.env.attempts;
    const final =
      err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!final) return;
    try {
      const item = await this.batches.findItemForJob(job.data.itemId);
      if (!item) return;
      await this.fail(item, BillParseErrorCode.AI_FAILED, failureMessage(err));
    } catch (e) {
      // The listener's rejection would be unhandled.
      this.log.error(
        `Could not fail item ${job.data.itemId}: ${(e as Error).message}`,
      );
    }
  }

  /** Back to queued and retried later without using an attempt. */
  private async delay(
    job: Job<BillPhotoJob>,
    token: string | undefined,
    item: BillPhotoJobItem,
    ms: number,
  ): Promise<never> {
    await this.batches.markItemQueued(item.id);
    await job.moveToDelayed(Date.now() + ms, token);
    throw new DelayedError();
  }

  private async record(
    item: BillPhotoJobItem,
    result: IngestResult,
  ): Promise<void> {
    switch (result.kind) {
      case 'existing':
      case 'draft':
        return this.done(item, result.billId);
      case 'not_a_receipt':
        return this.fail(
          item,
          BillParseErrorCode.NOT_A_RECEIPT,
          NOT_A_RECEIPT_MESSAGE,
          result.requestId,
        );
      case 'save_failed':
        return this.fail(
          item,
          BillParseErrorCode.SAVE_FAILED,
          SAVE_FAILED_MESSAGE,
          result.requestId,
        );
    }
  }

  private async done(item: BillPhotoJobItem, billId: string): Promise<void> {
    const res = await this.batches.markItemDone(item.id, billId);
    if (!res.changed) return;
    await this.publishItem(item, 'item.done', {
      status: BillBatchItemStatus.DONE,
      bill_id: billId,
    });
    await this.publishIfComplete(item, res.completion);
  }

  private async fail(
    item: BillPhotoJobItem,
    code: BillParseErrorCode,
    message: string,
    aiRequestId?: string,
  ): Promise<void> {
    const res = await this.batches.markItemFailed(item.id, {
      code,
      message,
      ...(aiRequestId ? { aiRequestId } : {}),
    });
    if (!res.changed) return;
    await this.publishItem(item, 'item.failed', {
      status: BillBatchItemStatus.FAILED,
      bill_id: res.billId!,
      parse_error_code: code,
      parse_error_message: message,
    });
    await this.publishIfComplete(item, res.completion);
  }

  /**
   * `completion` comes from the mark call that finished the batch's last
   * item, so exactly one call announces the batch.
   */
  private async publishIfComplete(
    item: BillPhotoJobItem,
    done: BatchCompletion | null,
  ): Promise<void> {
    if (!done) return;
    await this.events.publish(item.householdId, {
      type: 'batch.completed',
      data: {
        batch_id: item.batchId,
        ...done,
        created_by_user_id: item.createdById,
      },
    });
  }

  private publishItem(
    item: BillPhotoJobItem,
    type: 'item.processing' | 'item.done' | 'item.failed',
    data: Pick<ItemEvent, 'status'> & Partial<ItemEvent>,
  ): Promise<void> {
    return this.events.publish(item.householdId, {
      type,
      data: {
        batch_id: item.batchId,
        item_id: item.id,
        position: item.position,
        created_by_user_id: item.createdById,
        ...data,
      },
    });
  }
}
