import { Collection, type Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  ManyToOne,
  OneToMany,
  Index,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Category } from './category.entity';
import { BillSubCategory } from './bill-sub-category.entity';

@Entity({ tableName: 'sub_categories' })
// Case-insensitive unique name among a category's live sub-categories.
@Index({
  name: 'sub_categories_category_id_name_lower_unique',
  expression:
    'create unique index "sub_categories_category_id_name_lower_unique" on "sub_categories" ("category_id", lower("name")) where "deleted_at" is null',
})
export class SubCategory extends BaseEntity {
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

  @ManyToOne(() => Category, { nullable: false })
  category!: Rel<Category>;

  @OneToMany(
    () => BillSubCategory,
    (billSubCategory) => billSubCategory.sub_category,
  )
  billSubCategories = new Collection<BillSubCategory>(this);

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
