import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/core';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ThrottlerException } from '@nestjs/throttler';
import { Bill } from '../../../entities/bill.entity';
import { BillBatch } from '../../../entities/bill-batch.entity';
import { BillBatchItem } from '../../../entities/bill-batch-item.entity';
import { Household } from '../../../entities/household.entity';
import { User } from '../../../entities/user.entity';
import { BillStatus } from '../../../types/bill-status.enum';
import { BillBatchItemStatus } from '../../../types/bill-batch-item-status.enum';
import { BillParseErrorCode } from '../../../types/bill-parse-error.enum';
import { BillCrudService } from '../bill-crud.service';
import { STORAGE_SERVICE } from '../../storage/storage.service';
import type {
  ImageMediaType,
  StorageService,
} from '../../storage/storage.service';
import { AiUserQuota } from '../../ai-gateway/ai-user-quota.service';
import { AiGatewayService } from '../../ai-gateway/ai-gateway.service';
import { AI_USAGE_LIMITS } from '../../ai-gateway/internal/ai-usage-limits';
import type { AiUsageLimits } from '../../ai-gateway/internal/ai-usage-limits';
import { BILL_BATCH_ENV, BILL_PHOTO_QUEUE } from './bill-batch.env';
import type { BillBatchEnv } from './bill-batch.env';
import { BillEventsPublisher } from './bill-events.publisher';
import { BillBatchResponseDto } from './dto/bill-batch-response.dto';

export const QUEUE_FAILED_MESSAGE =
  'The photo could not be queued; retry later';

const JOB_RETENTION_SEC = 86_400;
const BACKOFF_MS = 5_000;
const UNFINISHED = [BillBatchItemStatus.QUEUED, BillBatchItemStatus.PROCESSING];

export interface BillPhotoJob {
  itemId: string;
}

/** The daily AI quota cannot cover the batch; the controller sets Retry-After. */
export class BillQuotaExceededException extends ThrottlerException {
  constructor(
    limit: number,
    readonly retryAfterSec: number,
  ) {
    // Same text as UserThrottlerGuard.
    super(
      `AI request limit reached: ${limit} per 24 hours. Try again in ${retryAfterSec} s.`,
    );
  }
}

/** Stores photo batches, queues their items and tracks item states. */
@Injectable()
export class BillBatchService {
  private readonly log = new Logger(BillBatchService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly crud: BillCrudService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly quota: AiUserQuota,
    private readonly gateway: AiGatewayService,
    @Inject(AI_USAGE_LIMITS) private readonly limits: AiUsageLimits,
    @InjectQueue(BILL_PHOTO_QUEUE) private readonly queue: Queue<BillPhotoJob>,
    private readonly events: BillEventsPublisher,
    @Inject(BILL_BATCH_ENV) private readonly env: BillBatchEnv,
  ) {}

  async createBatch(args: {
    householdId: string;
    userId: string;
    images: { buffer: Buffer; mediaType: ImageMediaType; sha256: string }[];
  }): Promise<BillBatchResponseDto> {
    const { householdId, userId, images } = args;
    if (images.length === 0) {
      throw new BadRequestException('At least one image is required');
    }
    // UserThrottlerGuard already counted the request as the first photo.
    await this.assertQuota(userId, images.length - 1);

    const keys: string[] = [];
    for (const image of images) {
      const { key } = await this.storage.put(
        image.buffer,
        image.mediaType,
        householdId,
      );
      keys.push(key);
    }

    const { batch, items } = await this.em.fork().transactional((em) =>
      Promise.resolve(
        this.insertBatch(
          em,
          householdId,
          userId,
          images.map((image, i) => ({ key: keys[i], sha256: image.sha256 })),
        ),
      ),
    );
    await this.enqueue(householdId, batch.id, items);
    return this.getBatch(householdId, batch.id);
  }

  async getBatch(
    householdId: string,
    batchId: string,
  ): Promise<BillBatchResponseDto> {
    const batch = await this.em.fork().findOne(
      BillBatch,
      { id: batchId, household: householdId },
      {
        populate: ['items.bill'],
        orderBy: { items: { position: 'asc' } },
      },
    );
    if (!batch) {
      throw new NotFoundException(`Bill batch with ID ${batchId} not found`);
    }
    const items = batch.items.getItems().map((item) => ({
      id: item.id,
      position: item.position,
      status: item.status,
      bill_id: item.bill?.id ?? null,
      parse_error_code: item.bill?.parse_error_code ?? null,
      parse_error_message: item.bill?.parse_error_message ?? null,
    }));
    return {
      batch_id: batch.id,
      created_at: batch.created_at.toISOString(),
      total: batch.total,
      completed: items.every((i) => !UNFINISHED.includes(i.status)),
      items,
    };
  }

  /** Parses a failed bill's photo again in a new one-item batch. */
  async retry(
    householdId: string,
    userId: string,
    billId: string,
  ): Promise<BillBatchResponseDto> {
    // Checked before the quota so a refused retry costs nothing.
    this.assertRetriable(
      await this.em
        .fork()
        .findOne(Bill, { id: billId, household: householdId }),
      billId,
    );
    await this.assertQuota(userId, 1);

    const { batch, items } = await this.em.fork().transactional(async (em) => {
      const bill = this.assertRetriable(
        await em.findOne(
          Bill,
          { id: billId, household: householdId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        ),
        billId,
      );
      // Deleted now, so deleting it while the retry runs is a 404.
      bill.deleted_at = new Date();
      return this.insertBatch(em, householdId, userId, [
        { key: bill.image_key!, sha256: bill.image_sha256! },
      ]);
    });
    await this.enqueue(householdId, batch.id, items);
    return this.getBatch(householdId, batch.id);
  }

  async markItemProcessing(itemId: string): Promise<{ changed: boolean }> {
    return this.moveUnfinished(itemId, BillBatchItemStatus.PROCESSING);
  }

  /** Back to queued, e.g. when a job is delayed by a rate limit. */
  async markItemQueued(itemId: string): Promise<{ changed: boolean }> {
    return this.moveUnfinished(itemId, BillBatchItemStatus.QUEUED);
  }

  async markItemDone(
    itemId: string,
    billId: string,
  ): Promise<{ changed: boolean }> {
    return this.em.fork().transactional(async (em) => {
      const item = await this.lockUnfinished(em, itemId);
      if (!item) return { changed: false };
      item.status = BillBatchItemStatus.DONE;
      item.bill = em.getReference(Bill, billId);
      item.updated_at = new Date();
      return { changed: true };
    });
  }

  /**
   * Fails the item and, unless `billId` is given, creates its failed bill in
   * the same transaction, so a re-run after a crash finds the item finished.
   */
  async markItemFailed(
    itemId: string,
    args: {
      code: BillParseErrorCode;
      message: string;
      aiRequestId?: string | null;
      billId?: string;
    },
  ): Promise<{ changed: boolean; billId: string | null }> {
    return this.em.fork().transactional(async (em) => {
      const item = await em.findOne(BillBatchItem, itemId, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      if (!item) return { changed: false, billId: null };
      if (!UNFINISHED.includes(item.status)) {
        return { changed: false, billId: item.bill?.id ?? null };
      }
      let billId = args.billId;
      if (!billId) {
        const batch = await em.findOneOrFail(BillBatch, item.batch.id);
        const bill = this.crud.createFailedBill(em, {
          householdId: batch.household.id,
          userId: batch.created_by?.id ?? null,
          imageKey: item.image_key,
          imageSha256: item.image_sha256,
          code: args.code,
          message: args.message,
          aiRequestId: args.aiRequestId,
        });
        // The id is generated by the database.
        await em.flush();
        billId = bill.id;
      }
      item.status = BillBatchItemStatus.FAILED;
      item.bill = em.getReference(Bill, billId);
      item.updated_at = new Date();
      return { changed: true, billId };
    });
  }

  /** Item counts once every item is done or failed; null while any runs. */
  async completionOf(
    batchId: string,
  ): Promise<{ total: number; done: number; failed: number } | null> {
    const items = await this.em
      .fork()
      .find(BillBatchItem, { batch: batchId }, { fields: ['status'] });
    if (items.some((i) => UNFINISHED.includes(i.status))) return null;
    const count = (s: BillBatchItemStatus) =>
      items.filter((i) => i.status === s).length;
    return {
      total: items.length,
      done: count(BillBatchItemStatus.DONE),
      failed: count(BillBatchItemStatus.FAILED),
    };
  }

  private async assertQuota(userId: string, extra: number): Promise<void> {
    const daily = await this.quota.reserveDaily(userId, extra);
    if (!daily.allowed) {
      throw new BillQuotaExceededException(
        this.limits.userPerDay,
        daily.retryAfterSec,
      );
    }
    await this.gateway.assertWithinBudget(userId);
  }

  private assertRetriable(bill: Bill | null, billId: string): Bill {
    if (!bill) throw new NotFoundException(`Bill with ID ${billId} not found`);
    if (
      bill.deleted_at ||
      bill.status !== BillStatus.FAILED ||
      !bill.image_key ||
      !bill.image_sha256
    ) {
      throw new ConflictException(
        'Only a failed bill with a stored photo can be retried',
      );
    }
    return bill;
  }

  private insertBatch(
    em: EntityManager,
    householdId: string,
    userId: string,
    photos: { key: string; sha256: string }[],
  ): { batch: BillBatch; items: BillBatchItem[] } {
    const now = new Date();
    const batch = new BillBatch();
    batch.household = em.getReference(Household, householdId);
    batch.created_by = em.getReference(User, userId);
    batch.total = photos.length;
    batch.created_at = now;
    em.persist(batch);
    const items = photos.map((photo, position) => {
      const item = new BillBatchItem();
      item.batch = batch;
      item.position = position;
      item.image_key = photo.key;
      item.image_sha256 = photo.sha256;
      item.status = BillBatchItemStatus.QUEUED;
      item.updated_at = now;
      em.persist(item);
      return item;
    });
    return { batch, items };
  }

  private async enqueue(
    householdId: string,
    batchId: string,
    items: BillBatchItem[],
  ): Promise<void> {
    try {
      await this.queue.addBulk(
        items.map((item) => ({
          name: BILL_PHOTO_QUEUE,
          data: { itemId: item.id },
          opts: {
            jobId: item.id,
            attempts: this.env.attempts,
            backoff: { type: 'exponential', delay: BACKOFF_MS },
            removeOnComplete: { age: JOB_RETENTION_SEC },
            removeOnFail: { age: JOB_RETENTION_SEC },
          },
        })),
      );
    } catch (err) {
      this.log.error(
        `Could not queue batch ${batchId}: ${(err as Error).message}`,
      );
      // Otherwise the items would stay queued forever.
      await this.failUnqueued(householdId, batchId, items);
    }
  }

  private async failUnqueued(
    householdId: string,
    batchId: string,
    items: BillBatchItem[],
  ): Promise<void> {
    const createdBy = items[0]?.batch.created_by?.id ?? null;
    let changed = false;
    for (const item of items) {
      const res = await this.markItemFailed(item.id, {
        code: BillParseErrorCode.AI_FAILED,
        message: QUEUE_FAILED_MESSAGE,
      });
      if (!res.changed) continue;
      changed = true;
      await this.events.publish(householdId, {
        type: 'item.failed',
        data: {
          batch_id: batchId,
          item_id: item.id,
          position: item.position,
          status: BillBatchItemStatus.FAILED,
          created_by_user_id: createdBy,
          bill_id: res.billId!,
          parse_error_code: BillParseErrorCode.AI_FAILED,
          parse_error_message: QUEUE_FAILED_MESSAGE,
        },
      });
    }
    const done = changed ? await this.completionOf(batchId) : null;
    if (done) {
      await this.events.publish(householdId, {
        type: 'batch.completed',
        data: { batch_id: batchId, ...done, created_by_user_id: createdBy },
      });
    }
  }

  private async lockUnfinished(
    em: EntityManager,
    itemId: string,
  ): Promise<BillBatchItem | null> {
    const item = await em.findOne(BillBatchItem, itemId, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });
    return item && UNFINISHED.includes(item.status) ? item : null;
  }

  private async moveUnfinished(
    itemId: string,
    status: BillBatchItemStatus,
  ): Promise<{ changed: boolean }> {
    const n = await this.em
      .fork()
      .nativeUpdate(
        BillBatchItem,
        { id: itemId, status: { $in: UNFINISHED } },
        { status, updated_at: new Date() },
      );
    return { changed: n > 0 };
  }
}
