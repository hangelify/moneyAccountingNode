import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  ManyToMany,
  ManyToOne,
  Collection,
  OneToMany,
  Index,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { PlaningHorizon } from './planing-horizon.entity';
import { SubCategory } from './sub-category.entity';
import { Household } from './household.entity';

@Entity({ tableName: 'categories' })
// Full, not partial on deleted_at: the parse-photo sub-category load does not
// filter categories.deleted_at, so a partial index would not be used.
@Index({ name: 'categories_household_id_index', properties: ['household'] })
export class Category extends BaseEntity {
  @Property({ type: 'varchar', length: 255, nullable: false })
  name!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  updated_at!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

  @ManyToMany(
    () => PlaningHorizon,
    (planingHorizon) => planingHorizon.categories,
  )
  planingHorizons = new Collection<PlaningHorizon>(this);

  @OneToMany(() => SubCategory, (subCategory) => subCategory.category)
  subCategories = new Collection<SubCategory>(this);

  @ManyToOne(() => Household, { nullable: false, deleteRule: 'cascade' })
  household!: Household;

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
