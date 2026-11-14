import type { Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  ManyToOne,
  Index,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Bill } from './bill.entity';
import { Category } from './category.entity';
import { SubCategory } from './sub-category.entity';

@Entity({ tableName: 'bill_sub_categories' })
// Partial: most lines on old bills have no category yet.
@Index({
  name: 'bill_sub_categories_category_id_partial_index',
  expression:
    'create index "bill_sub_categories_category_id_partial_index" on "bill_sub_categories" ("category_id") where "category_id" is not null',
})
@Index({
  name: 'bill_sub_categories_sub_category_id_partial_index',
  expression:
    'create index "bill_sub_categories_sub_category_id_partial_index" on "bill_sub_categories" ("sub_category_id") where "sub_category_id" is not null',
})
export class BillSubCategory extends BaseEntity {
  @ManyToOne(() => Bill, { nullable: false, deleteRule: 'cascade' })
  @Index()
  bill!: Rel<Bill>;

  @ManyToOne(() => SubCategory, { nullable: true, deleteRule: 'restrict' })
  sub_category?: Rel<SubCategory> | null;

  // The line's category; for a line with a sub-category, the sub-category's.
  @ManyToOne(() => Category, { nullable: true, deleteRule: 'restrict' })
  category?: Rel<Category> | null;

  @Property({ type: 'varchar', length: 255, nullable: false })
  raw_name!: string;

  @Property({ type: 'integer', nullable: false, default: 1 })
  product_count!: number;

  @Property({ type: 'decimal', precision: 19, scale: 2, nullable: false })
  amount!: number;

  @Property({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  product_weight?: number | null;

  @Property({ type: 'varchar', length: 10, nullable: true })
  unit?: string;

  @Property({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price_per_unit?: number | null;

  @Property({ type: 'decimal', precision: 5, scale: 4, nullable: true })
  category_confidence?: number | null;

  @Property({ type: 'text', nullable: true })
  category_reasoning?: string | null;
}
