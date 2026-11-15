import type { Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  Enum,
  ManyToOne,
  Index,
  Check,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Household } from './household.entity';
import { Category } from './category.entity';
import { User } from './user.entity';
import { Currency } from '../types/currency.enum';
import { LimitPeriodType } from '../types/limit-period-type.enum';

/**
 * One version of a category's spending limit, in force on
 * [effective_from, effective_to). Versions of one category never overlap;
 * the service keeps that, the database only allows one open version.
 */
@Entity({ tableName: 'category_limits' })
@Index({
  name: 'category_limits_category_open_unique',
  expression:
    'create unique index "category_limits_category_open_unique" on "category_limits" ("category_id") where "effective_to" is null',
})
// Report and GET: a household's limit versions by category and start.
@Index({
  name: 'category_limits_household_category_from_index',
  properties: ['household', 'category', 'effective_from'],
})
@Index({
  name: 'category_limits_created_by_id_index',
  properties: ['created_by'],
})
@Check({ name: 'category_limits_amount_positive', expression: 'amount > 0' })
@Check({
  name: 'category_limits_effective_range',
  expression: 'effective_to is null or effective_to > effective_from',
})
export class CategoryLimit extends BaseEntity {
  @ManyToOne(() => Household, {
    nullable: false,
    deleteRule: 'cascade',
    foreignKeyName: 'category_limits_household_id_fkey',
  })
  household!: Rel<Household>;

  @ManyToOne(() => Category, {
    nullable: false,
    deleteRule: 'cascade',
    foreignKeyName: 'category_limits_category_id_fkey',
  })
  category!: Rel<Category>;

  @Enum({
    items: () => LimitPeriodType,
    type: 'enum',
    nativeEnumName: 'limit_period_type',
    nullable: false,
  })
  period_type!: LimitPeriodType;

  @Property({ type: 'decimal', precision: 19, scale: 2, nullable: false })
  amount!: number;

  @Enum({
    items: () => Currency,
    type: 'enum',
    nativeEnumName: 'currency_enum',
    nullable: false,
  })
  currency!: Currency;

  /** `YYYY-MM-DD`, the first day of a period of `period_type`. */
  @Property({ type: 'date', runtimeType: 'string', nullable: false })
  effective_from!: string;

  /** `YYYY-MM-DD`, the first day the version no longer applies; null = open. */
  @Property({ type: 'date', runtimeType: 'string', nullable: true })
  effective_to!: string | null;

  @ManyToOne(() => User, {
    nullable: true,
    deleteRule: 'set null',
    fieldName: 'created_by_id',
    foreignKeyName: 'category_limits_created_by_id_fkey',
  })
  created_by!: Rel<User> | null;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  updated_at!: Date;

  @BeforeCreate()
  beforeCreate(): void {
    this.created_at = new Date();
    this.updated_at = new Date();
  }

  @BeforeUpdate()
  beforeUpdate(): void {
    this.updated_at = new Date();
  }
}
