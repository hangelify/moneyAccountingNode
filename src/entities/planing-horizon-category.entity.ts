import type { Rel } from '@mikro-orm/core';
import { Entity, ManyToOne, Index } from '@mikro-orm/decorators/legacy';
import { Category } from './category.entity';
import { PlaningHorizon } from './planing-horizon.entity';

/** Join table of PlaningHorizon.categories, declared to describe its indexes. */
@Entity({ tableName: 'planing_horizon_categories' })
export class PlaningHorizonCategory {
  @ManyToOne(() => PlaningHorizon, {
    primary: true,
    deleteRule: 'cascade',
    fieldName: 'planing_horizon_id',
  })
  @Index()
  planing_horizon!: Rel<PlaningHorizon>;

  @ManyToOne(() => Category, {
    primary: true,
    deleteRule: 'cascade',
    fieldName: 'category_id',
  })
  @Index()
  category!: Rel<Category>;
}
