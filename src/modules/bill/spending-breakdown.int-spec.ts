import { MikroORM, EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Category } from '../../entities/category.entity';
import { Household } from '../../entities/household.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { User } from '../../entities/user.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { Currency } from '../../types/currency.enum';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { EXCHANGE_RATE_PROVIDER } from '../exchange-rate/exchange-rate.provider';
import { StubProvider } from '../exchange-rate/testing/stub-exchange-rate.provider';
import { SpendingBreakdownService } from './spending-breakdown.service';
import { BillDashboardService } from './bill-dashboard.service';
import {
  foldSpendingRows,
  NO_SUB_CATEGORY_NAME,
  UNCATEGORIZED_NAME,
  type SpendingRow,
} from './spending-breakdown';
import { householdConversionJoin, loadRateDays } from './household-conversion';

// The queries as they were before lines carried their own category (HAN-93):
// the category came through the sub-category. Kept to prove the switch to
// bill_sub_categories.category_id changes nothing for lines with a
// sub-category. Drop once HAN-47 is done.
const LEGACY_JOIN_NAMES = `SELECT agg.currency, agg.sub_category_id,
                agg.total::text AS total, agg.lines::text AS lines,
                sc.name AS sub_name, c.id AS category_id,
                c.name AS category_name,
                (c.deleted_at IS NOT NULL) AS category_archived,
                (c.deleted_at IS NOT NULL OR sc.deleted_at IS NOT NULL) AS archived
         FROM agg
         LEFT JOIN sub_categories sc ON sc.id = agg.sub_category_id
         LEFT JOIN categories c ON c.id = sc.category_id`;
const LEGACY_BREAKDOWN = `WITH agg AS (
           SELECT b.currency, l.sub_category_id,
                  SUM(l.amount) AS total, COUNT(*) AS lines
           FROM bills b
           JOIN bill_sub_categories l ON l.bill_id = b.id
           WHERE b.household_id = ? AND b.status = 'confirmed'
             AND b.deleted_at IS NULL
             AND b.bill_date >= ? AND b.bill_date < ?
           GROUP BY b.currency, l.sub_category_id
         )
         ${LEGACY_JOIN_NAMES}`;
const LEGACY_CONVERTED_BREAKDOWN = `WITH agg AS (
           SELECT h.currency, l.sub_category_id,
                  ROUND(SUM(l.amount * fx.factor), 2) AS total,
                  COUNT(*) AS lines
           FROM bills b
           ${householdConversionJoin('b')}
           JOIN bill_sub_categories l ON l.bill_id = b.id
           WHERE b.household_id = ? AND b.status = 'confirmed'
             AND b.deleted_at IS NULL
             AND b.bill_date >= ? AND b.bill_date < ?
             AND fx.factor IS NOT NULL
           GROUP BY h.currency, l.sub_category_id
         )
         ${LEGACY_JOIN_NAMES}`;
const LEGACY_CATEGORY_STATS = `SELECT b.currency, c.id AS category_id, c.name AS category_name,
              SUM(bsc.amount)::text AS total_amount
       FROM bill_sub_categories bsc
       JOIN bills b ON b.id = bsc.bill_id
       JOIN sub_categories sc ON sc.id = bsc.sub_category_id
       JOIN categories c ON c.id = sc.category_id
       WHERE b.household_id = ? AND b.status = 'confirmed'
         AND b.bill_date >= ? AND b.bill_date < ?
         AND b.deleted_at IS NULL
         AND bsc.sub_category_id IS NOT NULL
       GROUP BY b.currency, c.id, c.name
       ORDER BY SUM(bsc.amount) DESC, c.name`;
const LEGACY_CONVERTED_CATEGORY_STATS = `SELECT h.currency, c.id AS category_id, c.name AS category_name,
              ROUND(SUM(bsc.amount * fx.factor), 2)::text AS total_amount
       FROM bills b
       ${householdConversionJoin('b')}
       JOIN bill_sub_categories bsc ON bsc.bill_id = b.id
       JOIN sub_categories sc ON sc.id = bsc.sub_category_id
       JOIN categories c ON c.id = sc.category_id
       WHERE b.household_id = ? AND b.status = 'confirmed'
         AND b.bill_date >= ? AND b.bill_date < ?
         AND b.deleted_at IS NULL
         AND bsc.sub_category_id IS NOT NULL
         AND fx.factor IS NOT NULL
       GROUP BY h.currency, c.id, c.name
       ORDER BY ROUND(SUM(bsc.amount * fx.factor), 2) DESC, c.name`;

// The spending-breakdown SQL against the real schema: household scoping,
// drafts and soft deletes, range boundaries, the Uncategorized bucket,
// archived categories and lines with a category but no sub-category. The
// dashboard's category stats share the fixture.
describe('spending breakdown SQL (PostgreSQL)', () => {
  let orm: MikroORM;
  let service: SpendingBreakdownService;
  let dashboard: BillDashboardService;
  let rates: ExchangeRateService;
  let householdId: string;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          ...createMikroOrmConfig(),
          allowGlobalContext: true,
        }),
        ExchangeRateModule,
      ],
      providers: [SpendingBreakdownService, BillDashboardService],
    })
      .overrideProvider(EXCHANGE_RATE_PROVIDER)
      .useValue(new StubProvider('TEST-SB'))
      .compile();
    orm = mod.get(MikroORM);
    service = mod.get(SpendingBreakdownService);
    dashboard = mod.get(BillDashboardService);
    rates = mod.get(ExchangeRateService);

    const em: EntityManager = orm.em.fork();
    const user = em.create(User, {
      first_name: 'Spend',
      email: 'spending-sql@example.com',
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Spend',
      currency: Currency.EUR,
      created_by: user,
    } as never);
    const other = em.create(Household, {
      name: 'Spend other',
      currency: Currency.EUR,
      created_by: user,
    } as never);
    const deletedAt = new Date('2026-06-01T00:00:00Z');
    const food = em.create(Category, { name: 'Food', household } as never);
    const home = em.create(Category, { name: 'Home', household } as never);
    const old = em.create(Category, {
      name: 'Old',
      household,
      deleted_at: deletedAt,
    } as never);
    const sub = (name: string, category: Category, extra = {}) =>
      em.create(SubCategory, { name, category, ...extra } as never);
    const bread = sub('bread', food);
    const milk = sub('milk', food);
    const candy = sub('candy', food, { deleted_at: deletedAt });
    const soap = sub('soap', home);
    const relic = sub('relic', old);

    // A line takes its sub-category's category, as the bill service does; a
    // Category alone is a line without a sub-category.
    const bill = (
      data: Record<string, unknown>,
      items: Array<[SubCategory | Category | null, number]>,
    ) => {
      const b = em.create(Bill, {
        household,
        created_by: user,
        status: BillStatus.CONFIRMED,
        currency: Currency.EUR,
        // Deliberately off from the lines: totals come from the lines.
        amount: 1,
        ...data,
      } as never);
      for (const [s, amount] of items) {
        const isSub = s instanceof SubCategory;
        em.create(BillSubCategory, {
          bill: b,
          sub_category: isSub ? s : null,
          category: isSub ? s.category : s,
          raw_name: 'item',
          product_count: 1,
          amount,
        } as never);
      }
    };

    // March 2026, EUR: first day, last day.
    bill({ bill_date: '2026-03-01' }, [
      [bread, 4.5],
      [milk, 1.1],
      [null, 2],
    ]);
    bill({ bill_date: '2026-03-31' }, [
      [soap, 6],
      [candy, 3],
      [relic, 5],
    ]);
    // Just outside March.
    bill({ bill_date: '2026-02-28' }, [[bread, 50]]);
    bill({ bill_date: '2026-04-01' }, [[bread, 100]]);
    // Other currencies inside March.
    bill({ bill_date: '2026-03-15', currency: Currency.USD }, [[bread, 10]]);
    bill({ bill_date: '2026-03-16', currency: null }, [[milk, 1]]);
    // Never counted: a draft, a deleted bill, another household.
    bill({ bill_date: '2026-03-10', status: BillStatus.DRAFT }, [[bread, 999]]);
    bill({ bill_date: '2026-03-11', deleted_at: new Date() }, [[bread, 555]]);
    bill({ bill_date: '2026-03-12', household: other }, [[bread, 777]]);
    // May 2026: lines with a category but no sub-category, one archived.
    bill({ bill_date: '2026-05-05' }, [
      [bread, 2],
      [food, 3],
      [food, 1],
      [old, 4],
      [null, 7],
    ]);

    await em.flush();
    householdId = household.id;
    Object.assign(id, {
      food: food.id,
      home: home.id,
      old: old.id,
      bread: bread.id,
      milk: milk.id,
      candy: candy.id,
      soap: soap.id,
      relic: relic.id,
    });
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it('builds the March tree per currency', async () => {
    const res = await service.getSpendingBreakdown(householdId, {
      period: 'custom',
      from: '2026-03-01',
      to: '2026-03-31',
    });

    expect(res.range).toEqual({
      period: 'custom',
      start: '2026-03-01',
      end: '2026-04-01',
    });
    expect(res.by_currency.map((s) => [s.currency, s.total, s.lines])).toEqual([
      [Currency.EUR, 21.6, 6],
      [Currency.USD, 10, 1],
      [null, 1, 1],
    ]);

    const [eur] = res.by_currency;
    expect(eur.categories).toEqual([
      {
        id: id.food,
        name: 'Food',
        total: 8.6,
        share: 39.81,
        archived: false,
        sub_categories: [
          {
            id: id.bread,
            name: 'bread',
            total: 4.5,
            share_of_category: 52.33,
            lines: 1,
            archived: false,
          },
          {
            id: id.candy,
            name: 'candy',
            total: 3,
            share_of_category: 34.88,
            lines: 1,
            archived: true,
          },
          {
            id: id.milk,
            name: 'milk',
            total: 1.1,
            share_of_category: 12.79,
            lines: 1,
            archived: false,
          },
        ],
      },
      {
        id: id.home,
        name: 'Home',
        total: 6,
        share: 27.78,
        archived: false,
        sub_categories: [
          {
            id: id.soap,
            name: 'soap',
            total: 6,
            share_of_category: 100,
            lines: 1,
            archived: false,
          },
        ],
      },
      {
        id: id.old,
        name: 'Old',
        total: 5,
        share: 23.15,
        archived: true,
        sub_categories: [
          {
            id: id.relic,
            name: 'relic',
            total: 5,
            share_of_category: 100,
            lines: 1,
            archived: true,
          },
        ],
      },
      {
        id: null,
        name: UNCATEGORIZED_NAME,
        total: 2,
        share: 9.26,
        archived: false,
        sub_categories: [],
      },
    ]);
  });

  it('gives the month period the same range as March from..to', async () => {
    const res = await service.getSpendingBreakdown(householdId, {
      period: 'month',
      anchor: '2026-03-15',
    });
    expect(res.range).toEqual({
      period: 'month',
      start: '2026-03-01',
      end: '2026-04-01',
    });
    expect(res.by_currency[0].total).toBe(21.6);
  });

  it('includes the start day and excludes the end day', async () => {
    const startOnly = await service.getSpendingBreakdown(householdId, {
      period: 'custom',
      from: '2026-03-01',
      to: '2026-03-01',
    });
    expect(startOnly.by_currency).toHaveLength(1);
    expect(startOnly.by_currency[0].total).toBe(7.6);

    // [2026-03-02, 2026-03-31): neither the 1st nor the 31st.
    const inner = await service.getSpendingBreakdown(householdId, {
      period: 'custom',
      from: '2026-03-02',
      to: '2026-03-30',
    });
    expect(inner.by_currency.map((s) => [s.currency, s.total])).toEqual([
      [Currency.USD, 10],
      [null, 1],
    ]);
  });

  it('filters by currency', async () => {
    const res = await service.getSpendingBreakdown(householdId, {
      period: 'month',
      anchor: '2026-03-15',
      currency: Currency.USD,
    });
    expect(res.by_currency).toHaveLength(1);
    expect(res.by_currency[0]).toMatchObject({
      currency: Currency.USD,
      total: 10,
      lines: 1,
    });
  });

  it('counts an ISO week that crosses the month', async () => {
    // Tue 2026-03-31 → Mon 2026-03-30 .. Mon 2026-04-06.
    const res = await service.getSpendingBreakdown(householdId, {
      period: 'week',
      anchor: '2026-03-31',
    });
    expect(res.range).toMatchObject({ start: '2026-03-30', end: '2026-04-06' });
    expect(res.by_currency.map((s) => [s.currency, s.total])).toEqual([
      [Currency.EUR, 114],
    ]);
  });

  it('returns no series for an empty range', async () => {
    const res = await service.getSpendingBreakdown(householdId, {
      period: 'year',
      anchor: '2020-06-01',
    });
    expect(res).toMatchObject({
      range: { period: 'year', start: '2020-01-01', end: '2021-01-01' },
      by_currency: [],
    });
  });

  describe('lines with a category but no sub-category', () => {
    const may = {
      period: 'custom' as const,
      from: '2026-05-01',
      to: '2026-05-31',
    };

    it('puts them in their category, as a last no-sub-category item', async () => {
      const res = await service.getSpendingBreakdown(householdId, may);

      const [eur] = res.by_currency;
      expect(eur.categories).toEqual([
        {
          id: id.food,
          name: 'Food',
          total: 6,
          share: 35.29,
          archived: false,
          sub_categories: [
            {
              id: id.bread,
              name: 'bread',
              total: 2,
              share_of_category: 33.33,
              lines: 1,
              archived: false,
            },
            {
              id: null,
              name: NO_SUB_CATEGORY_NAME,
              total: 4,
              share_of_category: 66.67,
              lines: 2,
              archived: false,
            },
          ],
        },
        {
          id: id.old,
          name: 'Old',
          total: 4,
          share: 23.53,
          archived: true,
          sub_categories: [
            {
              id: null,
              name: NO_SUB_CATEGORY_NAME,
              total: 4,
              share_of_category: 100,
              lines: 1,
              archived: true,
            },
          ],
        },
        {
          id: null,
          name: UNCATEGORIZED_NAME,
          total: 7,
          share: 41.18,
          archived: false,
          sub_categories: [],
        },
      ]);
      expect(res.in_household_currency.categories).toEqual(eur.categories);
    });

    it('counts them in the dashboard category stats', async () => {
      const res = await dashboard.getDashboard(householdId, {
        type: 'month',
        year: 2026,
        month: 5,
      } as never);

      const expected = [
        {
          category_id: id.food,
          category_name: 'Food',
          total_amount: 6,
          percentage: 60,
        },
        {
          category_id: id.old,
          category_name: 'Old',
          total_amount: 4,
          percentage: 40,
        },
      ];
      expect(res.by_currency[0].category_stats).toEqual(expected);
      expect(res.in_household_currency.category_stats).toEqual(expected);
    });
  });

  // Lines with a sub-category: the old path through sub_categories and the
  // line's own category_id give the same result.
  describe('same as the sub-category path for lines with a sub-category', () => {
    const start = '2026-02-01';
    const end = '2026-05-01';
    const legacy = async <T>(sql: string, converted: boolean): Promise<T[]> => {
      const conn = orm.em.getConnection();
      const source = rates.source;
      await loadRateDays(conn, rates, householdId, start, end);
      const params = [householdId, start, end];
      return (await conn.execute(
        sql,
        converted ? [source, source, ...params] : params,
      )) as T[];
    };

    it('breakdown', async () => {
      const res = await service.getSpendingBreakdown(householdId, {
        period: 'custom',
        from: start,
        to: '2026-04-30',
      });

      expect(res.by_currency).toEqual(
        foldSpendingRows(await legacy<SpendingRow>(LEGACY_BREAKDOWN, false)),
      );
      const [tree] = foldSpendingRows(
        await legacy<SpendingRow>(LEGACY_CONVERTED_BREAKDOWN, true),
      );
      expect(res.in_household_currency).toEqual({
        ...tree,
        unconverted: res.in_household_currency.unconverted,
      });
    });

    it('dashboard category stats', async () => {
      const conn = orm.em.getConnection();
      await loadRateDays(conn, rates, householdId, start, end);

      expect(
        await dashboard['fetchCategoryStats'](conn, householdId, start, end),
      ).toEqual(await legacy(LEGACY_CATEGORY_STATS, false));
      expect(
        await dashboard['fetchConvertedCategoryStats'](
          conn,
          rates.source,
          householdId,
          start,
          end,
        ),
      ).toEqual(await legacy(LEGACY_CONVERTED_CATEGORY_STATS, true));
    });
  });
});
