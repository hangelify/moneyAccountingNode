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
import { SpendingBreakdownService } from './spending-breakdown.service';
import { UNCATEGORIZED_NAME } from './spending-breakdown';

// The spending-breakdown SQL against the real schema: household scoping,
// drafts and soft deletes, range boundaries, the Uncategorized bucket and
// archived categories.
describe('spending breakdown SQL (PostgreSQL)', () => {
  let orm: MikroORM;
  let service: SpendingBreakdownService;
  let householdId: string;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          ...createMikroOrmConfig(),
          allowGlobalContext: true,
        }),
      ],
      providers: [SpendingBreakdownService],
    }).compile();
    orm = mod.get(MikroORM);
    service = mod.get(SpendingBreakdownService);

    const em: EntityManager = orm.em.fork();
    const user = em.create(User, {
      first_name: 'Spend',
      email: 'spending-sql@example.com',
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Spend',
      created_by: user,
    } as never);
    const other = em.create(Household, {
      name: 'Spend other',
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

    const bill = (
      data: Record<string, unknown>,
      items: Array<[SubCategory | null, number]>,
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
        em.create(BillSubCategory, {
          bill: b,
          sub_category: s,
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
    expect(res).toEqual({
      range: { period: 'year', start: '2020-01-01', end: '2021-01-01' },
      by_currency: [],
    });
  });
});
