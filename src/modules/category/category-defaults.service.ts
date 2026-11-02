import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { Category } from '../../entities/category.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { Household } from '../../entities/household.entity';
import { DEFAULT_CATEGORY_TREE } from './defaults';

export interface SeedCounts {
  categoriesCreated: number;
  subCategoriesCreated: number;
}

@Injectable()
export class CategoryDefaultsService {
  private readonly log = new Logger(CategoryDefaultsService.name);

  constructor(private readonly em: EntityManager) {}

  async seedForHousehold(householdId: string): Promise<SeedCounts> {
    const counts = await this.em.fork().transactional(async (em) => {
      // Concurrent seeds of one household (registration, a double click)
      // run one at a time: the second one sees the first one's rows.
      await em
        .getConnection()
        .execute(
          'select pg_advisory_xact_lock(hashtext(?))',
          [householdId],
          'all',
          em.getTransactionContext(),
        );
      return this.seed(em, householdId);
    });
    this.log.log(
      `Seeded defaults for household ${householdId}: +${counts.categoriesCreated} categories, +${counts.subCategoriesCreated} subcategories`,
    );
    return counts;
  }

  // Names match case-insensitively, as the unique indexes do.
  private async seed(
    em: EntityManager,
    householdId: string,
  ): Promise<SeedCounts> {
    const existingCats = await em.find(
      Category,
      { household: { id: householdId }, deleted_at: null },
      { populate: ['subCategories'] },
    );
    const byName = new Map<string, Category>(
      existingCats.map((c) => [c.name.toLowerCase(), c as Category]),
    );

    let categoriesCreated = 0;
    let subCategoriesCreated = 0;

    for (const node of DEFAULT_CATEGORY_TREE) {
      const existing = byName.get(node.name.toLowerCase());
      if (!existing) {
        const category = em.create(Category, {
          name: node.name,
          household: em.getReference(Household, householdId),
          created_at: new Date(),
          updated_at: new Date(),
        });
        em.persist(category);
        categoriesCreated += 1;
        for (const sub of node.subCategories) {
          const sc = em.create(SubCategory, {
            name: sub.name,
            category,
            created_at: new Date(),
            updated_at: new Date(),
          });
          em.persist(sc);
          subCategoriesCreated += 1;
        }
      } else {
        const existingSubNames = new Set(
          existing.subCategories
            .getItems()
            .filter((s) => !s.deleted_at)
            .map((s) => s.name.toLowerCase()),
        );
        for (const sub of node.subCategories) {
          if (existingSubNames.has(sub.name.toLowerCase())) continue;
          const sc = em.create(SubCategory, {
            name: sub.name,
            category: existing,
            created_at: new Date(),
            updated_at: new Date(),
          });
          em.persist(sc);
          subCategoriesCreated += 1;
        }
      }
    }

    await em.flush();
    return { categoriesCreated, subCategoriesCreated };
  }
}
