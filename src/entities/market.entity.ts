import type { Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  ManyToOne,
  Index,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Household } from './household.entity';

@Entity({ tableName: 'markets' })
@Index({
  name: 'markets_household_id_index',
  expression:
    'create index "markets_household_id_index" on "markets" ("household_id") where "deleted_at" is null',
})
export class Market extends BaseEntity {
  @Property({ type: 'varchar', length: 255, nullable: false })
  name!: string;

  @Property({ type: 'varchar', length: 500, nullable: true })
  address?: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  city?: string;

  @Property({ type: 'varchar', length: 2, nullable: true })
  country?: string;

  @ManyToOne(() => Household, { nullable: false })
  household!: Rel<Household>;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  updated_at!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

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
