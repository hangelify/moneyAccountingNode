import { MikroORM, EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Category } from '../../entities/category.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { User } from '../../entities/user.entity';
import { Household } from '../../entities/household.entity';
import { Currency } from '../../types/currency.enum';
import { CategoryDefaultsService } from './category-defaults.service';
import { DEFAULT_CATEGORY_TREE } from './defaults';

jest.setTimeout(30_000);

const NAME_PREFIX = 'seed-spec-household-';

describe('CategoryDefaultsService', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: CategoryDefaultsService;

  /** Create a throw-away User + Household for test isolation. */
  async function makeHousehold(label: string): Promise<Household> {
    const fork = em.fork();
    const u = fork.create(User, {
      email: `${NAME_PREFIX}${label}-${Date.now()}-${Math.random()}@test`,
      first_name: 'Seed',
      password: 'supersecret-password-for-test',
      currency: Currency.EUR,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const h = fork.create(Household, {
      name: `${NAME_PREFIX}${label}`,
      created_by: u,
      created_at: new Date(),
    });
    await fork.persist(u).persist(h).flush();
    return h;
  }

  async function cleanupOwned(): Promise<void> {
    if (!em) return;
    const fork = em.fork();
    // FK order: sub_categories → categories → households → users
    await fork.nativeDelete(SubCategory, {
      category: { household: { name: { $like: `${NAME_PREFIX}%` } } },
    });
    await fork.nativeDelete(Category, {
      household: { name: { $like: `${NAME_PREFIX}%` } },
    });
    await fork.nativeDelete(Household, { name: { $like: `${NAME_PREFIX}%` } });
    await fork.nativeDelete(User, {
      email: { $like: `${NAME_PREFIX}%` },
    });
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: PostgreSqlDriver,
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432', 10),
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
          dbName: process.env.DB_NAME || 'accounting',
          entities: ['./dist/**/*.entity.js'],
          entitiesTs: ['./src/**/*.entity.ts'],
          allowGlobalContext: true,
        }),
        MikroOrmModule.forFeature([Category, SubCategory]),
      ],
      providers: [CategoryDefaultsService],
    }).compile();
    orm = mod.get(MikroORM);
    em = orm.em;
    service = mod.get(CategoryDefaultsService);
  });

  beforeEach(cleanupOwned);
  afterAll(async () => {
    await cleanupOwned();
    if (orm) await orm.close(true);
  });

  it('creates 12 categories and ~70 subcategories for a fresh household', async () => {
    const household = await makeHousehold('fresh');
    const { categoriesCreated, subCategoriesCreated } =
      await service.seedForHousehold(household.id);
    const expectedCats = DEFAULT_CATEGORY_TREE.length;
    const expectedSubs = DEFAULT_CATEGORY_TREE.reduce(
      (n, c) => n + c.subCategories.length,
      0,
    );
    expect(categoriesCreated).toBe(expectedCats);
    expect(subCategoriesCreated).toBe(expectedSubs);
  });

  it('is idempotent — running twice creates 0 new rows the second time', async () => {
    const household = await makeHousehold('idempotent');
    await service.seedForHousehold(household.id);
    const second = await service.seedForHousehold(household.id);
    expect(second.categoriesCreated).toBe(0);
    expect(second.subCategoriesCreated).toBe(0);
  });

  it('restores a deleted category with its full default subcategory set', async () => {
    const household = await makeHousehold('del-cat');
    await service.seedForHousehold(household.id);
    const fork = em.fork();
    const bread = await fork.findOneOrFail(
      Category,
      { household: { id: household.id }, name: 'Bread', deleted_at: null },
      { populate: ['subCategories'] },
    );
    bread.deleted_at = new Date();
    for (const sub of bread.subCategories) {
      sub.deleted_at = new Date();
    }
    await fork.flush();

    const res = await service.seedForHousehold(household.id);
    const breadDefaults = DEFAULT_CATEGORY_TREE.find(
      (c) => c.name === 'Bread',
    )!;
    expect(res.categoriesCreated).toBe(1);
    expect(res.subCategoriesCreated).toBe(breadDefaults.subCategories.length);
  });

  it('re-adds a deleted subcategory without touching its siblings', async () => {
    const household = await makeHousehold('del-sub');
    await service.seedForHousehold(household.id);
    const fork = em.fork();
    const bread = await fork.findOneOrFail(
      Category,
      { household: { id: household.id }, name: 'Bread', deleted_at: null },
      { populate: ['subCategories'] },
    );
    const pita = bread.subCategories.getItems().find((s) => s.name === 'pita')!;
    pita.deleted_at = new Date();
    await fork.flush();

    const res = await service.seedForHousehold(household.id);
    expect(res.categoriesCreated).toBe(0);
    expect(res.subCategoriesCreated).toBe(1);
  });

  it('preserves household-added subcategories and adds only missing defaults', async () => {
    const household = await makeHousehold('custom');
    const fork = em.fork();
    const bread = fork.create(Category, {
      name: 'Bread',
      household: fork.getReference(Household, household.id),
      created_at: new Date(),
      updated_at: new Date(),
    });
    await fork.persist(bread).flush();
    for (const name of ['pita', 'tortilla']) {
      const sc = fork.create(SubCategory, {
        name,
        category: fork.getReference(Category, bread.id),
        created_at: new Date(),
        updated_at: new Date(),
      });
      fork.persist(sc);
    }
    await fork.flush();

    const res = await service.seedForHousehold(household.id);
    const breadDefaults = DEFAULT_CATEGORY_TREE.find(
      (c) => c.name === 'Bread',
    )!;
    expect(res.categoriesCreated).toBe(DEFAULT_CATEGORY_TREE.length - 1);
    const missingInBread = breadDefaults.subCategories.length - 1; // pita already there
    const allOtherSubs = DEFAULT_CATEGORY_TREE.filter(
      (c) => c.name !== 'Bread',
    ).reduce((n, c) => n + c.subCategories.length, 0);
    expect(res.subCategoriesCreated).toBe(missingInBread + allOtherSubs);

    const fork2 = em.fork();
    const tortilla = await fork2.findOne(SubCategory, { name: 'tortilla' });
    expect(tortilla).not.toBeNull();
  });
});
