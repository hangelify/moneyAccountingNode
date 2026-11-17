import type { Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  Enum,
  ManyToOne,
  Index,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Household } from './household.entity';
import { Category } from './category.entity';
import { User } from './user.entity';
import { LimitPeriodType } from '../types/limit-period-type.enum';

/**
 * "Do not carry this period's limit balance over to the next period":
 * one mark per category and period (HAN-25).
 */
@Entity({ tableName: 'category_limit_carry_stops' })
@Unique({
  name: 'category_limit_carry_stops_unique',
  properties: ['category', 'period_type', 'period_start'],
})
// Report: a household's marks by period type, category and period start.
@Index({
  name: 'category_limit_carry_stops_household_index',
  properties: ['household', 'period_type', 'category', 'period_start'],
})
@Index({
  name: 'category_limit_carry_stops_created_by_id_index',
  properties: ['created_by'],
})
export class CategoryLimitCarryStop extends BaseEntity {
  @ManyToOne(() => Household, {
    nullable: false,
    deleteRule: 'cascade',
    foreignKeyName: 'category_limit_carry_stops_household_id_fkey',
  })
  household!: Rel<Household>;

  @ManyToOne(() => Category, {
    nullable: false,
    deleteRule: 'cascade',
    foreignKeyName: 'category_limit_carry_stops_category_id_fkey',
  })
  category!: Rel<Category>;

  @Enum({
    items: () => LimitPeriodType,
    type: 'enum',
    nativeEnumName: 'limit_period_type',
    nullable: false,
  })
  period_type!: LimitPeriodType;

  /** `YYYY-MM-DD`, the first day of the period whose balance stops here. */
  @Property({ type: 'date', runtimeType: 'string', nullable: false })
  period_start!: string;

  @ManyToOne(() => User, {
    nullable: true,
    deleteRule: 'set null',
    fieldName: 'created_by_id',
    foreignKeyName: 'category_limit_carry_stops_created_by_id_fkey',
  })
  created_by!: Rel<User> | null;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;
}
