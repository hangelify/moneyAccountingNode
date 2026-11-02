import { Collection, type Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  ManyToMany,
  ManyToOne,
  OneToMany,
  Index,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { PlaningHorizon } from './planing-horizon.entity';
import { SubCategory } from './sub-category.entity';
import { Household } from './household.entity';

@Entity({ tableName: 'categories' })
// Full, not partial on deleted_at. Chosen when the parse-photo sub-category
// load did not filter categories.deleted_at; it does now, so a partial index
// would also be used, but switching needs a migration.
@Index({ name: 'categories_household_id_index', properties: ['household'] })
// Case-insensitive unique name among a household's live categories.
@Index({
  name: 'categories_household_id_name_lower_unique',
  expression:
    'create unique index "categories_household_id_name_lower_unique" on "categories" ("household_id", lower("name")) where "deleted_at" is null',
})
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
  household!: Rel<Household>;

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
