import { Collection, type Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  ManyToOne,
  OneToMany,
  Index,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { BillBatchItem } from './bill-batch-item.entity';
import { Household } from './household.entity';
import { User } from './user.entity';

/** One multi-photo upload; each photo is a `BillBatchItem`. */
@Entity({ tableName: 'bill_batches' })
@Index({ name: 'bill_batches_household_id_index', properties: ['household'] })
@Index({
  name: 'bill_batches_created_by_user_id_index',
  properties: ['created_by'],
})
export class BillBatch extends BaseEntity {
  @ManyToOne(() => Household, { nullable: false })
  household!: Rel<Household>;

  @ManyToOne(() => User, {
    nullable: true,
    deleteRule: 'set null',
    fieldName: 'created_by_user_id',
  })
  created_by?: Rel<User>;

  /** Number of photos in the upload (1-20). */
  @Property({ type: 'integer', nullable: false })
  total!: number;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @OneToMany(() => BillBatchItem, (item) => item.batch)
  items = new Collection<BillBatchItem>(this);
}
