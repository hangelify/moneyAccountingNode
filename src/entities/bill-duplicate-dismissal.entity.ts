import type { Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  ManyToOne,
  Index,
  Unique,
  Check,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Bill } from './bill.entity';
import { Household } from './household.entity';
import { User } from './user.entity';

/**
 * A pair of bills the user said are not duplicates. Stored once per pair,
 * `bill` holding the smaller id, so a second dismissal is a no-op.
 */
@Entity({ tableName: 'bill_duplicate_dismissals' })
@Check({
  name: 'bill_duplicate_dismissals_order_check',
  expression: '"bill_id" < "other_bill_id"',
})
@Unique({
  name: 'bill_duplicate_dismissals_pair_unique',
  properties: ['bill', 'other_bill'],
})
@Index({
  name: 'bill_duplicate_dismissals_other_bill_id_index',
  properties: ['other_bill'],
})
@Index({
  name: 'bill_duplicate_dismissals_household_id_index',
  properties: ['household'],
})
@Index({
  name: 'bill_duplicate_dismissals_dismissed_by_user_id_index',
  properties: ['dismissed_by'],
})
export class BillDuplicateDismissal extends BaseEntity {
  @ManyToOne(() => Household, { nullable: false })
  household!: Rel<Household>;

  /** The smaller id of the pair. */
  @ManyToOne(() => Bill, { nullable: false })
  bill!: Rel<Bill>;

  /** The larger id of the pair. */
  @ManyToOne(() => Bill, { nullable: false })
  other_bill!: Rel<Bill>;

  @ManyToOne(() => User, {
    nullable: true,
    deleteRule: 'set null',
    fieldName: 'dismissed_by_user_id',
  })
  dismissed_by?: Rel<User>;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;
}
