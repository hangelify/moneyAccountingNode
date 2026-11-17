import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { defined } from '../../common/testing/defined';
import { LimitPeriodType } from '../../types/limit-period-type.enum';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { EXCHANGE_RATE_PROVIDER, ExchangeRateService } from '../exchange-rate';
import { StubProvider } from '../exchange-rate/testing';
import { SpendingBreakdownService } from '../bill';
import { CategoryLimitService } from './category-limit.service';
import { LimitReportService } from './limit-report.service';
import type {
  LimitReportCategoryDto,
  LimitReportDto,
} from './dto/limit-report.dto';

jest.setTimeout(60_000);

const SOURCE = 'TEST-LR';

// MDL per unit, as the stub provider answers; other days are never published.
// USD → EUR = 0.9, MDL → EUR = 0.05.
const RATES: Record<string, Record<string, number>> = {
  '2026-06-01': { EUR: 20.0, USD: 18.0 },
  '2026-11-13': { EUR: 20.0, USD: 18.0 },
};

const NOW = new Date('2026-11-15T10:00:00Z');
const at = (day: string): Date => new Date(`${day}T10:00:00Z`);
const { MONTHLY, QUARTERLY, SEMI_ANNUAL, YEARLY } = LimitPeriodType;

interface BillOpts {
  currency?: string | null;
  status?: 'confirmed' | 'draft' | 'failed' | 'duplicate';
  deleted?: boolean;
  duplicateOf?: string;
}

/** `[category, amount, sub-category?]`; a null category = uncategorized. */
type Line = [string | null, number, string?];

// Limits report (HAN-25): spending per category against the limit of the
// period, with the balance carried along the chain of periods.
describe('limits report (PostgreSQL)', () => {
  let orm: MikroORM;
  let limits: CategoryLimitService;
  let reports: LimitReportService;
  let spending: SpendingBreakdownService;
  const userId = randomUUID();
  // Every household the specs create, for the cleanup.
  const households = new Set<string>();
  // Household of each category, so helpers take the category alone.
  const householdOf = new Map<string, string>();

  const sql = <T = unknown>(
    query: string,
    params: unknown[] = [],
  ): Promise<T> => orm.em.getConnection().execute(query, params) as Promise<T>;

  beforeAll(async () => {
    const provider = new StubProvider(SOURCE);
    provider.answer = (date) =>
      Promise.resolve(
        RATES[date]
          ? {
              date,
              rates: Object.entries(RATES[date]).map(([currency, rate]) => ({
                currency,
                rate,
                nominal: 1,
              })),
            }
          : null,
      );
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          ...createMikroOrmConfig(),
          allowGlobalContext: true,
        }),
        ExchangeRateModule,
      ],
      providers: [
        CategoryLimitService,
        LimitReportService,
        SpendingBreakdownService,
      ],
    })
      .overrideProvider(EXCHANGE_RATE_PROVIDER)
      .useValue(provider)
      .compile();
    orm = mod.get(MikroORM);
    limits = mod.get(CategoryLimitService);
    reports = mod.get(LimitReportService);
    spending = mod.get(SpendingBreakdownService);
    await mod
      .get(ExchangeRateService)
      .ensureDays(Object.keys(RATES), { max: 10 });

    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Report', ?, 'x')`,
      [userId, `limit-report-${userId}@example.com`],
    );
  });

  afterAll(async () => {
    const hids = [...households.values()];
    const inHh = 'household_id = any(?::uuid[])';
    const arr = `{${hids.join(',')}}`;
    await sql(`delete from category_limit_carry_stops where ${inHh}`, [arr]);
    await sql(`delete from category_limits where ${inHh}`, [arr]);
    await sql(
      `delete from bill_sub_categories where bill_id in (select id from bills where ${inHh})`,
      [arr],
    );
    await sql(
      `delete from bills where ${inHh} and duplicate_of_id is not null`,
      [arr],
    );
    await sql(`delete from bills where ${inHh}`, [arr]);
    await sql(
      `delete from sub_categories where category_id in (select id from categories where ${inHh})`,
      [arr],
    );
    await sql(`delete from categories where ${inHh}`, [arr]);
    await sql(`delete from households where id = any(?::uuid[])`, [arr]);
    await sql('delete from users where id = ?', [userId]);
    await sql('delete from exchange_rates where source = ?', [SOURCE]);
    await sql('delete from exchange_rate_days where source = ?', [SOURCE]);
    await orm.close(true);
  });

  /** A fresh household, so household-wide numbers are the test's own. */
  async function household(currency = 'EUR'): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into households (id, name, created_by, currency) values (?, 'Report', ?, ?)`,
      [id, userId, currency],
    );
    households.add(id);
    return id;
  }

  async function category(hid: string, name?: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into categories (id, name, household_id) values (?, ?, ?)`,
      [id, name ?? `Report ${id}`, hid],
    );
    householdOf.set(id, hid);
    return id;
  }

  async function subCategory(categoryId: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into sub_categories (id, name, category_id) values (?, ?, ?)`,
      [id, `sub ${id}`, categoryId],
    );
    return id;
  }

  /** A bill of `lines`; returns the bill id and the line ids in order. */
  async function bill(
    hid: string,
    day: string,
    lines: Line[],
    opts: BillOpts = {},
  ): Promise<{ id: string; lines: string[] }> {
    const id = randomUUID();
    const status = opts.status ?? 'confirmed';
    await sql(
      `insert into bills (id, household_id, created_by_user_id, bill_date, amount,
                          status, currency, deleted_at, duplicate_of_id, parse_error_code)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        hid,
        userId,
        day,
        lines.reduce((s, [, amount]) => s + amount, 0),
        status,
        opts.currency === undefined ? 'EUR' : opts.currency,
        opts.deleted ? new Date() : null,
        opts.duplicateOf ?? null,
        status === 'failed' ? 'ai_failed' : null,
      ],
    );
    const lineIds: string[] = [];
    for (const [cat, amount, sub] of lines) {
      const lineId = randomUUID();
      await sql(
        `insert into bill_sub_categories (id, bill_id, category_id, sub_category_id, raw_name, product_count, amount)
         values (?, ?, ?, ?, 'item', 1, ?)`,
        [lineId, id, cat, sub ?? null, amount],
      );
      lineIds.push(lineId);
    }
    return { id, lines: lineIds };
  }

  /** Sets the amount of a one-line bill, line and total alike. */
  async function setAmount(
    b: { id: string; lines: string[] },
    amount: number,
  ): Promise<void> {
    await sql(`update bill_sub_categories set amount = ? where id = ?`, [
      amount,
      defined(b.lines[0], 'line'),
    ]);
    await sql(`update bills set amount = ? where id = ?`, [amount, b.id]);
  }

  async function stop(
    hid: string,
    categoryId: string,
    type: LimitPeriodType,
    periodStart: string,
  ): Promise<void> {
    await sql(
      `insert into category_limit_carry_stops (id, household_id, category_id, period_type, period_start)
       values (?, ?, ?, ?, ?)`,
      [randomUUID(), hid, categoryId, type, periodStart],
    );
  }

  const unstop = (categoryId: string): Promise<unknown> =>
    sql('delete from category_limit_carry_stops where category_id = ?', [
      categoryId,
    ]);

  /** Creates the category's limit as if on `day`; returns the version id. */
  async function limit(
    categoryId: string,
    type: LimitPeriodType,
    amount: number,
    day: string,
  ): Promise<string> {
    const dto = await limits.create(
      householdOf.get(categoryId) ?? '',
      userId,
      { category_id: categoryId, period_type: type, amount },
      at(day),
    );
    return dto.id;
  }

  const report = (
    hid: string,
    type: LimitPeriodType,
    date?: string,
  ): Promise<LimitReportDto> => reports.report(hid, type, date, NOW);

  /** The category's row of the report; fails when it is not listed. */
  function row(r: LimitReportDto, categoryId: string): LimitReportCategoryDto {
    const found = r.categories.find((c) => c.category_id === categoryId);
    if (!found) throw new Error(`${categoryId} is not in the report`);
    return found;
  }

  it.each([
    {
      type: MONTHLY,
      day: '2026-02-10',
      start: '2026-02-01',
      end: '2026-03-01',
      last: '2026-02-28',
    },
    {
      type: QUARTERLY,
      day: '2026-04-10',
      start: '2026-04-01',
      end: '2026-07-01',
      last: '2026-06-30',
    },
    {
      type: SEMI_ANNUAL,
      day: '2026-01-10',
      start: '2026-01-01',
      end: '2026-07-01',
      last: '2026-06-30',
    },
    {
      type: YEARLY,
      day: '2025-01-10',
      start: '2025-01-01',
      end: '2026-01-01',
      last: '2025-12-31',
    },
  ])(
    '$type bounds: last day in, next first day out',
    async ({ type, day, start, end, last }) => {
      const hid = await household();
      const cat = await category(hid);
      await limit(cat, type, 1000, day);
      const dayBefore = new Date(Date.parse(`${start}T00:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10);
      await bill(hid, start, [[cat, 1]]);
      await bill(hid, last, [[cat, 10]]);
      await bill(hid, end, [[cat, 100]]);
      await bill(hid, dayBefore, [[cat, 1000]]);

      const r = await report(hid, type, day);

      expect([r.start, r.end, r.period_type]).toEqual([start, end, type]);
      expect(row(r, cat)).toMatchObject({ spent: 11, carried_in: 0 });
    },
  );

  it('past period uses the version then in force; month → quarter switch per HAN-24 example', async () => {
    const hid = await household();
    const cat = await category(hid);
    const v1 = await limit(cat, MONTHLY, 300, '2026-09-10');
    const v2 = (
      await limits.update(
        hid,
        userId,
        cat,
        { period_type: MONTHLY, amount: 350 },
        at('2026-11-05'),
      )
    ).id;

    expect(row(await report(hid, MONTHLY, '2026-09-15'), cat)).toMatchObject({
      limit_id: v1,
      limit_amount: 300,
      carried_in: 0,
    });
    expect(row(await report(hid, MONTHLY, '2026-11-15'), cat)).toMatchObject({
      limit_id: v2,
      limit_amount: 350,
      base_limit: 350,
      // September and October unspent: 300 + 300.
      carried_in: 600,
    });

    // 15 November: "quarter 1000" from 2026-10-01; V2 dropped, V1 ends 10-01.
    const v3 = (
      await limits.update(
        hid,
        userId,
        cat,
        { period_type: QUARTERLY, amount: 1000 },
        NOW,
      )
    ).id;

    expect(row(await report(hid, MONTHLY, '2026-09-15'), cat)).toMatchObject({
      limit_id: v1,
      limit_amount: 300,
    });
    expect((await report(hid, MONTHLY, '2026-10-15')).categories).toEqual([]);
    expect((await report(hid, MONTHLY, '2026-11-15')).categories).toEqual([]);
    expect(row(await report(hid, QUARTERLY, '2026-11-15'), cat)).toMatchObject({
      limit_id: v3,
      limit_amount: 1000,
      carried_in: 0,
      limit: 1000,
    });
    expect((await report(hid, QUARTERLY, '2026-09-15')).categories).toEqual([]);
  });

  it('spec example: Sept 110 of 100 → Oct limit 90; mark Sept → 100; unmark → 90; Sept 80 → 120', async () => {
    const hid = await household();
    const cat = await category(hid);
    await limit(cat, MONTHLY, 100, '2026-09-05');
    const sept = await bill(hid, '2026-09-10', [[cat, 110]]);

    expect(row(await report(hid, MONTHLY, '2026-10-10'), cat)).toMatchObject({
      base_limit: 100,
      carried_in: -10,
      limit: 90,
      spent: 0,
      remaining: 90,
      percent: 0,
      carry_over: true,
      carry_incomplete: false,
    });

    await stop(hid, cat, MONTHLY, '2026-09-01');
    expect(row(await report(hid, MONTHLY, '2026-10-10'), cat)).toMatchObject({
      carried_in: 0,
      limit: 100,
    });
    expect(row(await report(hid, MONTHLY, '2026-09-10'), cat)).toMatchObject({
      carry_over: false,
      spent: 110,
      remaining: -10,
      percent: 110,
    });

    await unstop(cat);
    expect(row(await report(hid, MONTHLY, '2026-10-10'), cat).limit).toBe(90);

    await setAmount(sept, 80);
    expect(row(await report(hid, MONTHLY, '2026-10-10'), cat)).toMatchObject({
      carried_in: 20,
      limit: 120,
    });
  });

  it('editing an old bill changes the carry into the current period', async () => {
    const hid = await household();
    const cat = await category(hid);
    await limit(cat, MONTHLY, 100, '2026-09-05');
    const sept = await bill(hid, '2026-09-10', [[cat, 50]]);
    await bill(hid, '2026-10-10', [[cat, 100]]);

    // Sept: 100 - 50 = 50 → Oct: 150 - 100 = 50 → Nov 150.
    expect(row(await report(hid, MONTHLY), cat)).toMatchObject({
      carried_in: 50,
      limit: 150,
    });

    await setAmount(sept, 70);
    expect(row(await report(hid, MONTHLY), cat)).toMatchObject({
      carried_in: 30,
      limit: 130,
    });
  });

  it('removed limit shows until period end; recreated starts without carry', async () => {
    const hid = await household();
    const cat = await category(hid);
    await limit(cat, MONTHLY, 100, '2026-10-05');
    await bill(hid, '2026-10-10', [[cat, 30]]);
    await limits.remove(hid, cat, NOW);

    expect(row(await report(hid, MONTHLY, '2026-11-20'), cat)).toMatchObject({
      carried_in: 70,
      limit: 170,
    });
    expect((await report(hid, MONTHLY, '2026-12-10')).categories).toEqual([]);

    // December has no version, so the chain is broken.
    await limit(cat, MONTHLY, 100, '2027-01-10');
    expect(row(await report(hid, MONTHLY, '2027-01-10'), cat)).toMatchObject({
      carried_in: 0,
      limit: 100,
    });
  });

  it('spent equals the spending breakdown total of the category to the cent', async () => {
    const hid = await household();
    const cat = await category(hid);
    const subs = [
      await subCategory(cat),
      await subCategory(cat),
      await subCategory(cat),
    ];
    await limit(cat, MONTHLY, 100, '2026-06-10');
    // × 0.9: 0.945, 1.935, 2.925 — half cents, rounded per sub-category.
    await bill(
      hid,
      '2026-06-01',
      [
        [cat, 1.05, subs[0]],
        [cat, 2.15, subs[1]],
        [cat, 3.25, subs[2]],
      ],
      { currency: 'USD' },
    );

    const r = await report(hid, MONTHLY, '2026-06-15');
    const breakdown = await spending.getSpendingBreakdown(hid, {
      period: 'custom',
      from: '2026-06-01',
      to: '2026-06-30',
    });
    const inBreakdown = breakdown.in_household_currency.categories.find(
      (c) => c.id === cat,
    );

    expect(row(r, cat).spent).toBe(inBreakdown?.total);
    expect(row(r, cat).spent).toBe(5.82);
  });

  it('counts the converted part only', async () => {
    const hid = await household();
    const cat = await category(hid);
    await limit(cat, MONTHLY, 100, '2026-06-05');
    // 10 USD × 0.9 = 9 EUR.
    await bill(hid, '2026-06-01', [[cat, 10]], { currency: 'USD' });
    // No USD rate in the 7 days up to 06-20.
    await bill(hid, '2026-06-20', [[cat, 20]], { currency: 'USD' });

    const r = await report(hid, MONTHLY, '2026-06-15');

    expect(row(r, cat)).toMatchObject({ spent: 9, unconverted_lines: 1 });
    expect(r.unconverted).toEqual([
      { currency: 'USD', bill_count: 1, amount: 20 },
    ]);
    expect(r.other_spent).toBe(0);
    expect(r.total.spent).toBe(9);
  });

  it('bill without currency is unconverted', async () => {
    const hid = await household();
    const cat = await category(hid);
    await limit(cat, MONTHLY, 100, '2026-06-05');
    await bill(hid, '2026-06-03', [[cat, 31]], { currency: null });

    const r = await report(hid, MONTHLY, '2026-06-15');

    expect(row(r, cat)).toMatchObject({ spent: 0, unconverted_lines: 1 });
    expect(r.unconverted).toEqual([
      { currency: null, bill_count: 1, amount: 31 },
    ]);
  });

  it('limit in another currency converts at the period start rate; without a rate base_limit is null and out of the total', async () => {
    const hid = await household('MDL');
    const june = await category(hid, 'June');
    const april = await category(hid, 'April');
    await limit(june, MONTHLY, 200, '2026-06-10');
    await limit(april, MONTHLY, 200, '2026-04-10');
    await sql(`update households set currency = 'EUR' where id = ?`, [hid]);
    await bill(hid, '2026-04-15', [[april, 5]]);

    const jun = await report(hid, MONTHLY, '2026-06-15');
    expect(jun.currency).toBe('EUR');
    expect(row(jun, june)).toMatchObject({
      limit_amount: 200,
      limit_currency: 'MDL',
      // 200 MDL at 06-01: / 20.
      base_limit: 10,
      carried_in: 0,
      limit: 10,
    });
    // April and May had no rate: the chain restarts in June, inexactly.
    expect(row(jun, april)).toMatchObject({
      base_limit: 10,
      carried_in: 0,
      carry_incomplete: true,
    });

    const apr = await report(hid, MONTHLY, '2026-04-15');
    expect(apr.categories.map((c) => c.category_id)).toEqual([april]);
    expect(row(apr, april)).toMatchObject({
      limit_amount: 200,
      limit_currency: 'MDL',
      base_limit: null,
      limit: null,
      remaining: null,
      percent: null,
      spent: 5,
    });
    expect(apr.total).toEqual({
      base_limit: 0,
      carried_in: 0,
      limit: 0,
      spent: 0,
      remaining: 0,
      percent: null,
    });

    // A future period converts at today's rate (11-15 → saved 11-13).
    const dec = await report(hid, MONTHLY, '2026-12-15');
    expect(row(dec, june).base_limit).toBe(10);
  });

  it('drafts, failed, duplicates and deleted bills are not counted', async () => {
    const hid = await household();
    const cat = await category(hid);
    await limit(cat, MONTHLY, 1000, '2026-11-05');
    const original = await bill(hid, '2026-11-02', [[cat, 10]]);
    await bill(hid, '2026-11-02', [[cat, 100]], { status: 'draft' });
    await bill(hid, '2026-11-02', [[cat, 200]], { status: 'failed' });
    await bill(hid, '2026-11-02', [[cat, 400]], {
      status: 'duplicate',
      duplicateOf: original.id,
    });
    await bill(hid, '2026-11-02', [[cat, 800]], { deleted: true });

    expect(row(await report(hid, MONTHLY), cat).spent).toBe(10);
  });

  it('a negative line lowers spent', async () => {
    const hid = await household();
    const cat = await category(hid);
    await limit(cat, MONTHLY, 1000, '2026-11-05');
    await bill(hid, '2026-11-02', [
      [cat, 50],
      [cat, -20],
    ]);

    expect(row(await report(hid, MONTHLY), cat).spent).toBe(30);
  });

  it('a line with a category and no sub-category counts in its category', async () => {
    const hid = await household();
    const cat = await category(hid);
    const sub = await subCategory(cat);
    await limit(cat, MONTHLY, 1000, '2026-11-05');
    await bill(hid, '2026-11-02', [
      [cat, 10, sub],
      [cat, 5],
    ]);

    expect(row(await report(hid, MONTHLY), cat).spent).toBe(15);
  });

  it('other_spent: uncategorized and categories without any limit; a quarterly-limited category is not in the monthly other_spent', async () => {
    const hid = await household();
    const monthly = await category(hid);
    const quarterly = await category(hid);
    const free = await category(hid);
    await limit(monthly, MONTHLY, 1000, '2026-09-10');
    await limit(quarterly, QUARTERLY, 1000, '2026-10-10');
    await bill(hid, '2026-11-02', [
      [monthly, 10],
      [quarterly, 20],
      [free, 40],
      [null, 80],
    ]);
    // Before the period: fetched for the chain, not in other_spent.
    await bill(hid, '2026-10-02', [
      [free, 1000],
      [null, 1000],
    ]);

    const r = await report(hid, MONTHLY);

    expect(r.categories.map((c) => c.category_id)).toEqual([monthly]);
    expect(r.other_spent).toBe(120);
  });

  it('archived category with a limit in force is listed', async () => {
    const hid = await household();
    const cat = await category(hid, 'Archived');
    await limit(cat, MONTHLY, 100, '2026-11-05');
    await sql(`update categories set deleted_at = now() where id = ?`, [cat]);

    expect(row(await report(hid, MONTHLY), cat)).toMatchObject({
      category_name: 'Archived',
      category_archived: true,
    });
  });

  it('future period: carry from the current one, spent from existing bills', async () => {
    const hid = await household();
    const cat = await category(hid);
    await limit(cat, MONTHLY, 100, '2026-10-05');
    await bill(hid, '2026-10-10', [[cat, 30]]);
    await bill(hid, '2026-11-10', [[cat, 50]]);
    await bill(hid, '2026-12-02', [[cat, 5]]);

    // Oct: 100 - 30 = 70 → Nov: 170 - 50 = 120 → Dec 220.
    expect(row(await report(hid, MONTHLY, '2026-12-15'), cat)).toMatchObject({
      carried_in: 120,
      limit: 220,
      spent: 5,
      remaining: 215,
    });
  });

  it('empty before the first limit', async () => {
    const hid = await household();
    const cat = await category(hid);
    await limit(cat, MONTHLY, 100, '2026-11-05');
    await bill(hid, '2020-01-10', [
      [cat, 7],
      [null, 3],
    ]);

    const r = await report(hid, MONTHLY, '2020-01-15');

    expect(r).toEqual({
      period_type: MONTHLY,
      start: '2020-01-01',
      end: '2020-02-01',
      currency: 'EUR',
      categories: [],
      total: {
        base_limit: 0,
        carried_in: 0,
        limit: 0,
        spent: 0,
        remaining: 0,
        percent: null,
      },
      other_spent: 10,
      unconverted: [],
    });
  });

  it('ignores another household', async () => {
    const a = await household();
    const b = await household();
    const catA = await category(a, 'Food');
    const catB = await category(b, 'Food');
    await limit(catA, MONTHLY, 100, '2026-10-05');
    await limit(catB, MONTHLY, 100, '2026-10-05');
    await bill(a, '2026-10-10', [[catA, 30]]);
    await bill(a, '2026-11-10', [
      [catA, 10],
      [null, 1],
    ]);
    await bill(b, '2026-10-10', [[catB, 500]]);
    await bill(b, '2026-11-10', [
      [catB, 500],
      [null, 500],
    ]);
    await bill(b, '2026-11-10', [[catB, 7]], { currency: null });
    await stop(b, catB, MONTHLY, '2026-10-01');

    const r = await report(a, MONTHLY);

    expect(r.categories.map((c) => c.category_id)).toEqual([catA]);
    expect(row(r, catA)).toMatchObject({
      carried_in: 70,
      spent: 10,
      unconverted_lines: 0,
    });
    expect(r.other_spent).toBe(1);
    expect(r.unconverted).toEqual([]);
  });

  it('defaults date to today', async () => {
    const hid = await household();

    const r = await report(hid, MONTHLY);

    expect([r.start, r.end]).toEqual(['2026-11-01', '2026-12-01']);
  });
});
