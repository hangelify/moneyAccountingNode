import type { Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  ManyToOne,
  Enum,
  Index,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Bill } from './bill.entity';
import { BillBatch } from './bill-batch.entity';
import { BillBatchItemStatus } from '../types/bill-batch-item-status.enum';

/** One photo of a batch; its id is also the BullMQ job id. */
@Entity({ tableName: 'bill_batch_items' })
@Unique({
  name: 'bill_batch_items_batch_id_position_unique',
  properties: ['batch', 'position'],
})
@Index({ name: 'bill_batch_items_bill_id_index', properties: ['bill'] })
export class BillBatchItem extends BaseEntity {
  @ManyToOne(() => BillBatch, { nullable: false, deleteRule: 'cascade' })
  batch!: Rel<BillBatch>;

  /** 0-based order in the upload. */
  @Property({ type: 'integer', nullable: false })
  position!: number;

  @Property({ type: 'varchar', nullable: false })
  image_key!: string;

  /** sha256 (hex) of the prepared image. */
  @Property({ type: 'varchar', length: 64, nullable: false })
  image_sha256!: string;

  @Enum({
    items: () => BillBatchItemStatus,
    type: 'enum',
    nativeEnumName: 'bill_batch_item_status_enum',
    nullable: false,
    default: BillBatchItemStatus.QUEUED,
  })
  status: BillBatchItemStatus = BillBatchItemStatus.QUEUED;

  /** The draft or failed bill; set when the item is done or failed. */
  @ManyToOne(() => Bill, { nullable: true, deleteRule: 'set null' })
  bill?: Rel<Bill> | null;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  updated_at!: Date;
}
