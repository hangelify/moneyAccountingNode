import { Collection, type Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  BeforeCreate,
  OneToMany,
  ManyToOne,
  Index,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { PlaningHorizon } from './planing-horizon.entity';
import { Household } from './household.entity';

@Entity({ tableName: 'budgets' })
// Case-insensitive unique name among a household's live budgets.
@Index({
  name: 'budgets_household_id_name_lower_unique',
  expression:
    'create unique index "budgets_household_id_name_lower_unique" on "budgets" ("household_id", lower("name")) where "deleted_at" is null',
})
export class Budget extends BaseEntity {
  @Property({ type: 'varchar', length: 255, nullable: false })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

  @ManyToOne(() => Household, { nullable: false })
  household!: Rel<Household>;

  @OneToMany(() => PlaningHorizon, (planingHorizon) => planingHorizon.budget)
  planingHorizons = new Collection<PlaningHorizon>(this);

  @BeforeCreate()
  beforeCreate() {
    this.created_at = new Date();
  }
}
