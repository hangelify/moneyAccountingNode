import { Collection, type Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  Enum,
  ManyToOne,
  ManyToMany,
  Index,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Currency } from '../types/currency.enum';
import { PeriodType } from '../types/period-type.enum';
import { Budget } from './budget.entity';
import { Category } from './category.entity';

@Entity({ tableName: 'planing_horizons' })
// Case-insensitive unique name among a budget's active planning horizons.
@Index({
  name: 'planing_horizons_budget_id_name_lower_unique',
  expression:
    'create unique index "planing_horizons_budget_id_name_lower_unique" on "planing_horizons" ("budget_id", lower("name")) where "deleted_at" is null and not "is_archived"',
})
export class PlaningHorizon extends BaseEntity {
  @Property({ type: 'varchar', length: 255, nullable: false })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'decimal', precision: 19, scale: 2, nullable: false })
  amount!: number;

  @Enum({
    items: () => Currency,
    type: 'enum',
    nativeEnumName: 'currency_enum',
    nullable: false,
  })
  currency!: Currency;

  @Enum({
    items: () => PeriodType,
    type: 'enum',
    nativeEnumName: 'period_type_enum',
    nullable: false,
  })
  period_type!: PeriodType;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  updated_at!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

  @Property({ type: 'boolean', nullable: false, default: false })
  is_archived!: boolean;

  @ManyToOne(() => Budget, { nullable: false })
  budget!: Rel<Budget>;

  @ManyToMany(() => Category, (category) => category.planingHorizons, {
    owner: true,
    pivotTable: 'planing_horizon_categories',
    joinColumn: 'planing_horizon_id',
    inverseJoinColumn: 'category_id',
  })
  categories = new Collection<Category>(this);

  @BeforeCreate()
  beforeCreate() {
    this.created_at = new Date();
    this.updated_at = new Date();
  }

  @BeforeUpdate()
  beforeUpdate() {
    this.updated_at = new Date();
  }
}
