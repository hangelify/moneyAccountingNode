import { Currency } from '../../types/currency.enum';
import { LimitPeriodType } from '../../types/limit-period-type.enum';
import {
  buildLimitReport,
  CarryStop,
  chainPeriods,
  LimitReportCategory,
  LimitReportInput,
  ReportVersion,
  SpentRow,
} from './limit-report';

const { MONTHLY, QUARTERLY, YEARLY } = LimitPeriodType;
const START = '2026-10-01';
const END = '2026-11-01';

const version = (
  id: string,
  category_id: string,
  amount: string,
  [effective_from, effective_to]: [string, string | null],
): ReportVersion => ({
  id,
  category_id,
  amount,
  currency: Currency.EUR,
  effective_from,
  effective_to,
});

const FOOD = version('v-food', 'food', '100', ['2026-01-01', null]);
const stop = (category_id: string, period_start: string): CarryStop => ({
  category_id,
  period_start,
});

const starts = (
  chain: { period_start: string }[] | undefined,
): string[] | undefined => chain?.map((p) => p.period_start);

const months = (from: number, to: number): string[] =>
  Array.from(
    { length: to - from + 1 },
    (_, i) => `2026-${String(from + i).padStart(2, '0')}-01`,
  );

describe('chainPeriods', () => {
  it('runs back to the first period of the version', () => {
    const chains = chainPeriods(MONTHLY, START, [FOOD], []);
    expect(starts(chains.get('food'))).toEqual(months(1, 10));
    expect(chains.get('food')?.every((p) => p.version === FOOD)).toBe(true);
  });

  it('starts after the latest stop', () => {
    const chains = chainPeriods(
      MONTHLY,
      START,
      [FOOD],
      [stop('food', '2026-03-01'), stop('food', '2026-07-01')],
    );
    expect(starts(chains.get('food'))).toEqual(months(8, 10));
  });

  it('ignores a stop on the report period itself', () => {
    const chains = chainPeriods(MONTHLY, START, [FOOD], [stop('food', START)]);
    expect(starts(chains.get('food'))).toEqual(months(1, 10));
  });

  it('keeps the chain across an amount change', () => {
    const a = version('a', 'food', '100', ['2026-01-01', '2026-06-01']);
    const b = version('b', 'food', '150', ['2026-06-01', null]);
    const chain = chainPeriods(MONTHLY, START, [a, b], []).get('food');
    expect(starts(chain)).toEqual(months(1, 10));
    expect(chain?.[4]?.version).toBe(a);
    expect(chain?.[5]?.version).toBe(b);
  });

  it('breaks on a period without a version', () => {
    const a = version('a', 'food', '100', ['2026-01-01', '2026-04-01']);
    const b = version('b', 'food', '100', ['2026-05-01', null]);
    const chains = chainPeriods(MONTHLY, START, [a, b], []);
    expect(starts(chains.get('food'))).toEqual(months(5, 10));
  });

  it('omits a category with no version in the period', () => {
    const closed = version('a', 'food', '100', ['2026-01-01', START]);
    expect(chainPeriods(MONTHLY, START, [closed], []).has('food')).toBe(false);
  });

  it('ignores a stop outside the chain', () => {
    const chains = chainPeriods(
      MONTHLY,
      START,
      [FOOD],
      [stop('food', '2025-12-01')],
    );
    expect(starts(chains.get('food'))).toEqual(months(1, 10));
  });

  it('keeps categories apart', () => {
    const rent = version('r', 'rent', '500', ['2026-09-01', null]);
    const chains = chainPeriods(
      MONTHLY,
      START,
      [FOOD, rent],
      [stop('rent', '2026-05-01')],
    );
    expect(starts(chains.get('food'))).toEqual(months(1, 10));
    expect(starts(chains.get('rent'))).toEqual(months(9, 10));
  });

  it('handles quarters and half-years', () => {
    const q = version('q', 'food', '300', ['2026-01-01', null]);
    expect(starts(chainPeriods(QUARTERLY, START, [q], []).get('food'))).toEqual(
      ['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01'],
    );
    const h = version('h', 'food', '600', ['2025-07-01', null]);
    expect(
      starts(
        chainPeriods(LimitPeriodType.SEMI_ANNUAL, '2026-07-01', [h], []).get(
          'food',
        ),
      ),
    ).toEqual(['2025-07-01', '2026-01-01', '2026-07-01']);
  });

  it('runs a monthly chain across a year boundary', () => {
    const v = version('v', 'food', '100', ['2025-11-01', null]);
    expect(
      starts(chainPeriods(MONTHLY, '2026-02-01', [v], []).get('food')),
    ).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
  });

  it('handles years', () => {
    const y = version('y', 'food', '1200', ['2024-01-01', null]);
    expect(
      starts(chainPeriods(YEARLY, '2026-01-01', [y], []).get('food')),
    ).toEqual(['2024-01-01', '2025-01-01', '2026-01-01']);
  });
});

describe('buildLimitReport', () => {
  const spent = (
    month: number,
    total: string,
    category_id: string | null = 'food',
    unconverted_lines = 0,
  ): SpentRow => ({
    category_id,
    bucket: `2026-${String(month).padStart(2, '0')}-01`,
    total,
    unconverted_lines,
  });

  /** Food spends exactly its limit in every earlier month the rows skip. */
  const withHistory = (rows: SpentRow[]): SpentRow[] => {
    const named = new Set(
      rows.filter((r) => r.category_id === 'food').map((r) => r.bucket),
    );
    const balanced = months(1, 9)
      .filter((m) => !named.has(m))
      .map((m) => ({ ...spent(1, '100'), bucket: m }));
    return [...balanced, ...rows];
  };

  const input = (over: Partial<LimitReportInput> = {}): LimitReportInput => {
    const versions = over.chains ? [] : [FOOD];
    const stops = over.stops ?? [];
    const baseLimits = new Map<string, string | null>(
      months(1, 10).map((m) => [`v-food|${m}`, '100']),
    );
    return {
      type: MONTHLY,
      start: START,
      end: END,
      currency: Currency.EUR,
      chains: chainPeriods(MONTHLY, START, versions, stops),
      categories: new Map([
        ['food', { category_id: 'food', name: 'Food', archived: false }],
      ]),
      baseLimits,
      stops,
      limitedCategoryIds: new Set(['food']),
      unconverted: [],
      ...over,
      spent: withHistory(over.spent ?? []),
    };
  };

  const food = (
    over: Partial<LimitReportInput> = {},
  ): LimitReportCategory | undefined =>
    buildLimitReport(input(over)).categories[0];

  it('reports a fresh period', () => {
    const report = buildLimitReport(input({ spent: [spent(10, '30')] }));
    expect(report).toEqual({
      period_type: MONTHLY,
      start: START,
      end: END,
      currency: Currency.EUR,
      categories: [
        {
          category_id: 'food',
          category_name: 'Food',
          category_archived: false,
          limit_id: 'v-food',
          limit_amount: 100,
          limit_currency: Currency.EUR,
          base_limit: 100,
          carried_in: 0,
          limit: 100,
          spent: 30,
          remaining: 70,
          percent: 30,
          carry_over: true,
          carry_incomplete: false,
          unconverted_lines: 0,
        },
      ],
      total: {
        base_limit: 100,
        carried_in: 0,
        limit: 100,
        spent: 30,
        remaining: 70,
        percent: 30,
      },
      other_spent: 0,
      unconverted: [],
    });
  });

  it('carries a debt into the next period', () => {
    const row = food({ spent: [spent(9, '110')] });
    expect(row).toMatchObject({ carried_in: -10, limit: 90, remaining: 90 });
  });

  it('carries a surplus', () => {
    const row = food({ spent: [spent(9, '80')] });
    expect(row).toMatchObject({ carried_in: 20, limit: 120 });
  });

  it('accumulates over periods', () => {
    // Aug 110 → Sep limit 90; Sep 105 → Oct carried_in 90 - 105 = -15.
    const row = food({ spent: [spent(8, '110'), spent(9, '105')] });
    expect(row).toMatchObject({ carried_in: -15, limit: 85 });
  });

  it('stops carrying after a marked period', () => {
    const stops = [stop('food', '2026-09-01')];
    const row = food({ stops, spent: [spent(9, '110')] });
    expect(row).toMatchObject({ carried_in: 0, limit: 100, carry_over: true });
  });

  it('marks the report period as not carried over', () => {
    const row = food({ stops: [stop('food', START)] });
    expect(row?.carry_over).toBe(false);
  });

  it('debt larger than the limit', () => {
    const row = food({ spent: [spent(9, '250'), spent(10, '5')] });
    expect(row).toMatchObject({
      carried_in: -150,
      limit: -50,
      remaining: -55,
      percent: null,
    });
  });

  it('percent above 100 and below 0', () => {
    expect(food({ spent: [spent(10, '150')] })?.percent).toBe(150);
    expect(food({ spent: [spent(10, '-5')] })?.percent).toBe(-5);
    expect(food({ spent: [spent(10, '33.33')] })?.percent).toBe(33.33);
  });

  it('restarts after an unconvertible base limit', () => {
    const base = input().baseLimits;
    base.set('v-food|2026-09-01', null);
    const report = buildLimitReport(
      input({ baseLimits: base, spent: [spent(8, '150'), spent(9, '50')] }),
    );
    expect(report.categories[0]).toMatchObject({
      carried_in: 0,
      limit: 100,
      carry_incomplete: true,
    });
  });

  it('carries again after a period with an unconvertible base limit', () => {
    const base = input().baseLimits;
    base.set('v-food|2026-08-01', null);
    const row = food({ baseLimits: base, spent: [spent(9, '80')] });
    expect(row).toMatchObject({
      carried_in: 20,
      limit: 120,
      carry_incomplete: true,
    });
  });

  it('folds a monthly chain across a year boundary', () => {
    const v = version('v', 'food', '100', ['2025-11-01', null]);
    const start = '2026-02-01';
    const report = buildLimitReport({
      ...input(),
      start,
      end: '2026-03-01',
      chains: chainPeriods(MONTHLY, start, [v], []),
      baseLimits: new Map(
        ['2025-11-01', '2025-12-01', '2026-01-01', start].map((m) => [
          `v|${m}`,
          '100',
        ]),
      ),
      // Nov 90 → Dec 110 - 120 = -10 → Jan 90 - 70 = 20 → Feb 120.
      spent: [
        { ...spent(1, '90'), bucket: '2025-11-01' },
        { ...spent(1, '120'), bucket: '2025-12-01' },
        spent(1, '70'),
      ],
    });
    expect(report.categories[0]).toMatchObject({
      carried_in: 20,
      limit: 120,
      carry_incomplete: false,
    });
  });

  it('reports an unconvertible base limit in the period', () => {
    const base = input().baseLimits;
    base.set(`v-food|${START}`, null);
    const report = buildLimitReport(
      input({ baseLimits: base, spent: [spent(10, '40')] }),
    );
    expect(report.categories[0]).toMatchObject({
      base_limit: null,
      limit: null,
      remaining: null,
      percent: null,
      spent: 40,
    });
    expect(report.total).toEqual({
      base_limit: 0,
      carried_in: 0,
      limit: 0,
      spent: 0,
      remaining: 0,
      percent: null,
    });
  });

  it('flags unconverted lines in an earlier period', () => {
    const row = food({ spent: [spent(8, '10', 'food', 1)] });
    expect(row?.carry_incomplete).toBe(true);
    expect(row?.unconverted_lines).toBe(0);
  });

  it('reports unconverted lines of the period without flagging the carry', () => {
    const row = food({ spent: [spent(10, '10', 'food', 2)] });
    expect(row).toMatchObject({
      carry_incomplete: false,
      unconverted_lines: 2,
    });
  });

  it('sums several rows per category and period', () => {
    const row = food({
      spent: [spent(9, '60', 'food', 1), spent(9, '30'), spent(10, '7')],
    });
    expect(row).toMatchObject({ carried_in: 10, spent: 7 });
  });

  it('counts other spending', () => {
    const report = buildLimitReport(
      input({
        limitedCategoryIds: new Set(['food', 'travel']),
        spent: [
          spent(10, '12', null),
          spent(10, '8', 'clothes'),
          spent(10, '50', 'travel'),
          spent(9, '99', null),
        ],
      }),
    );
    expect(report.other_spent).toBe(20);
    expect(report.categories.map((c) => c.category_id)).toEqual(['food']);
  });

  it('totals only convertible limits', () => {
    const rent = version('v-rent', 'rent', '500', ['2026-10-01', null]);
    rent.currency = Currency.USD;
    const base = input().baseLimits;
    base.set(`v-rent|${START}`, null);
    const report = buildLimitReport(
      input({
        chains: chainPeriods(MONTHLY, START, [FOOD, rent], []),
        categories: new Map([
          ['food', { category_id: 'food', name: 'Food', archived: false }],
          ['rent', { category_id: 'rent', name: 'Rent', archived: true }],
        ]),
        baseLimits: base,
        limitedCategoryIds: new Set(['food', 'rent']),
        spent: [spent(9, '90'), spent(10, '20'), spent(10, '300', 'rent')],
      }),
    );
    expect(report.categories[1]).toMatchObject({
      category_archived: true,
      limit_amount: 500,
      limit_currency: Currency.USD,
      base_limit: null,
      spent: 300,
    });
    expect(report.total).toEqual({
      base_limit: 100,
      carried_in: 10,
      limit: 110,
      spent: 20,
      remaining: 90,
      percent: 18.18,
    });
  });

  it('rounds in cents', () => {
    const row = food({ spent: [spent(10, '0.1'), spent(10, '0.2')] });
    expect(row?.spent).toBe(0.3);
    expect(row?.remaining).toBe(99.7);
  });

  it('empty report', () => {
    const report = buildLimitReport(
      input({ chains: new Map(), spent: [spent(10, '5', null)] }),
    );
    expect(report.categories).toEqual([]);
    expect(report.total).toEqual({
      base_limit: 0,
      carried_in: 0,
      limit: 0,
      spent: 0,
      remaining: 0,
      percent: null,
    });
    expect(report.other_spent).toBe(5);
  });

  it('passes unconverted bills through', () => {
    const unconverted = [{ currency: Currency.USD, bill_count: 1, amount: 9 }];
    expect(buildLimitReport(input({ unconverted })).unconverted).toBe(
      unconverted,
    );
  });

  it('sorts by name then id', () => {
    const versions = ['c', 'a', 'b'].map((id) =>
      version(`v-${id}`, id, '10', [START, null]),
    );
    const report = buildLimitReport(
      input({
        chains: chainPeriods(MONTHLY, START, versions, []),
        categories: new Map([
          ['c', { category_id: 'c', name: 'Alpha', archived: false }],
          ['a', { category_id: 'a', name: 'Beta', archived: false }],
          ['b', { category_id: 'b', name: 'Alpha', archived: false }],
        ]),
        baseLimits: new Map(versions.map((x) => [`${x.id}|${START}`, '10'])),
      }),
    );
    expect(report.categories.map((c) => c.category_id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});
