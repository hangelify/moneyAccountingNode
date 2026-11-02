import type { Rel } from '@mikro-orm/core';
import { Entity, Property, ManyToOne } from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Bill } from './bill.entity';
import { SubCategory } from './sub-category.entity';

@Entity({ tableName: 'bill_sub_categories' })
export class BillSubCategory extends BaseEntity {
  @ManyToOne(() => Bill, { nullable: false })
  bill!: Rel<Bill>;

  @ManyToOne(() => SubCategory, { nullable: true })
  sub_category?: Rel<SubCategory> | null;

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
