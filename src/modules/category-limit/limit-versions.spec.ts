import { Currency } from '../../types/currency.enum';
import { LimitPeriodType } from '../../types/limit-period-type.enum';
import { addDays, limitPeriodStart } from '../../common/utils/period-range';
import {
  LimitChange,
  LimitPlan,
  LimitVersion,
  planLimitChange,
} from './limit-versions';

const { MONTHLY, QUARTERLY, SEMI_ANNUAL, YEARLY } = LimitPeriodType;
const TODAY = '2026-11-15';

const v = (
  id: string,
  period_type: LimitPeriodType,
  amount: number,
  [effective_from, effective_to]: [string, string | null],
): LimitVersion => ({
  id,
  period_type,
  amount,
  currency: Currency.EUR,
  effective_from,
  effective_to,
});

const set = (
  period_type: LimitPeriodType,
  amount: number,
  currency: Currency = Currency.EUR,
): LimitChange => ({ kind: 'set', period_type, amount, currency });

const insertOf = (
  period_type: LimitPeriodType,
  amount: number,
  effective_from: string,
  currency: Currency = Currency.EUR,
): Omit<LimitVersion, 'id'> => ({
  period_type,
  amount,
  currency,
  effective_from,
  effective_to: null,
});

describe('planLimitChange', () => {
  it('set on an empty category', () => {
    expect(planLimitChange([], set(MONTHLY, 400), TODAY)).toEqual({
      delete: [],
      update: [],
      insert: insertOf(MONTHLY, 400, '2026-11-01'),
      unchanged: false,
    });
  });

  it('amount change in a later period', () => {
    const plan = planLimitChange(
      [v('a', MONTHLY, 300, ['2026-09-01', null])],
      set(MONTHLY, 350),
      TODAY,
    );
    expect(plan.delete).toEqual([]);
    expect(plan.update).toEqual([{ id: 'a', effective_to: '2026-11-01' }]);
    expect(plan.insert).toEqual(insertOf(MONTHLY, 350, '2026-11-01'));
  });

  it('second change in the same period', () => {
    const plan = planLimitChange(
      [v('a', MONTHLY, 300, ['2026-11-01', null])],
      set(MONTHLY, 350),
      TODAY,
    );
    expect(plan.delete).toEqual(['a']);
    expect(plan.update).toEqual([]);
    expect(plan.insert).toEqual(insertOf(MONTHLY, 350, '2026-11-01'));
  });

  it('month -> quarter (spec example)', () => {
    const plan = planLimitChange(
      [
        v('a', MONTHLY, 300, ['2026-09-01', '2026-11-01']),
        v('b', MONTHLY, 350, ['2026-11-01', null]),
      ],
      set(QUARTERLY, 1000),
      TODAY,
    );
    expect(plan.delete).toEqual(['b']);
    expect(plan.update).toEqual([{ id: 'a', effective_to: '2026-10-01' }]);
    expect(plan.insert).toEqual(insertOf(QUARTERLY, 1000, '2026-10-01'));
  });

  it('quarter -> month', () => {
    const plan = planLimitChange(
      [v('q', QUARTERLY, 1000, ['2026-07-01', null])],
      set(MONTHLY, 400),
      TODAY,
    );
    expect(plan.delete).toEqual([]);
    expect(plan.update).toEqual([{ id: 'q', effective_to: '2026-11-01' }]);
    expect(plan.insert).toEqual(insertOf(MONTHLY, 400, '2026-11-01'));
  });

  it('month -> year rewrites the whole year', () => {
    const plan = planLimitChange(
      [
        v('a', MONTHLY, 300, ['2026-01-01', '2026-06-01']),
        v('b', MONTHLY, 350, ['2026-06-01', null]),
      ],
      set(YEARLY, 5000),
      TODAY,
    );
    expect(plan.delete).toEqual(['a', 'b']);
    expect(plan.update).toEqual([]);
    expect(plan.insert).toEqual(insertOf(YEARLY, 5000, '2026-01-01'));
  });

  it('idempotent set', () => {
    expect(
      planLimitChange(
        [v('a', MONTHLY, 400, ['2026-11-01', null])],
        set(MONTHLY, 400),
        TODAY,
      ),
    ).toEqual({ delete: [], update: [], insert: null, unchanged: true });
  });

  it('same amount, other currency is a change', () => {
    const plan = planLimitChange(
      [v('a', MONTHLY, 400, ['2026-11-01', null])],
      set(MONTHLY, 400, Currency.MDL),
      TODAY,
    );
    expect(plan.unchanged).toBe(false);
    expect(plan.delete).toEqual(['a']);
    expect(plan.insert).toEqual(
      insertOf(MONTHLY, 400, '2026-11-01', Currency.MDL),
    );
  });

  it('remove keeps the limit to the end of its period', () => {
    const plan = planLimitChange(
      [v('a', QUARTERLY, 1000, ['2026-10-01', null])],
      { kind: 'remove' },
      TODAY,
    );
    expect(plan.update).toEqual([{ id: 'a', effective_to: '2027-01-01' }]);
    expect(plan.delete).toEqual([]);
    expect(plan.insert).toBeNull();
    expect(plan.unchanged).toBe(false);
  });

  it('remove without an open version', () => {
    expect(
      planLimitChange(
        [v('a', MONTHLY, 300, ['2026-09-01', '2026-12-01'])],
        { kind: 'remove' },
        TODAY,
      ),
    ).toEqual({ delete: [], update: [], insert: null, unchanged: true });
    expect(planLimitChange([], { kind: 'remove' }, TODAY).unchanged).toBe(true);
  });

  it('set after remove in the same period', () => {
    const plan = planLimitChange(
      [v('a', MONTHLY, 300, ['2026-09-01', '2026-12-01'])],
      set(MONTHLY, 500),
      TODAY,
    );
    expect(plan.delete).toEqual([]);
    expect(plan.update).toEqual([{ id: 'a', effective_to: '2026-11-01' }]);
    expect(plan.insert).toEqual(insertOf(MONTHLY, 500, '2026-11-01'));
  });

  it('set after remove, closed version started this period', () => {
    const plan = planLimitChange(
      [v('a', MONTHLY, 300, ['2026-11-01', '2026-12-01'])],
      set(MONTHLY, 500),
      TODAY,
    );
    expect(plan.delete).toEqual(['a']);
    expect(plan.update).toEqual([]);
    expect(plan.insert).toEqual(insertOf(MONTHLY, 500, '2026-11-01'));
  });

  it('first day of the period', () => {
    const plan = planLimitChange(
      [v('a', MONTHLY, 300, ['2026-10-01', null])],
      set(MONTHLY, 350),
      '2026-11-01',
    );
    expect(plan.delete).toEqual([]);
    expect(plan.update).toEqual([{ id: 'a', effective_to: '2026-11-01' }]);
    expect(plan.insert).toEqual(insertOf(MONTHLY, 350, '2026-11-01'));
  });

  it('does not mutate its input', () => {
    const versions = [
      v('a', MONTHLY, 300, ['2026-09-01', '2026-11-01']),
      v('b', MONTHLY, 350, ['2026-11-01', null]),
    ];
    const copy = structuredClone(versions);
    planLimitChange(versions, set(QUARTERLY, 1000), TODAY);
    planLimitChange(versions, { kind: 'remove' }, TODAY);
    expect(versions).toEqual(copy);
  });

  describe('property: no overlaps after any sequence', () => {
    const TYPES = [MONTHLY, QUARTERLY, SEMI_ANNUAL, YEARLY];
    const CURRENCIES = [Currency.EUR, Currency.MDL];

    // Seeded LCG (Numerical Recipes constants).
    const makeRng = (seed: number): ((n: number) => number) => {
      let s = seed >>> 0;
      return (n: number) => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return Math.floor((s / 2 ** 32) * n);
      };
    };

    const pick = <T>(rng: (n: number) => number, items: T[]): T =>
      items[rng(items.length)] as T;

    const assertInvariants = (all: LimitVersion[]): void => {
      expect(
        all.filter((x) => x.effective_to === null).length,
      ).toBeLessThanOrEqual(1);
      const sorted = [...all].sort((a, b) =>
        a.effective_from.localeCompare(b.effective_from),
      );
      sorted.forEach((x, i) => {
        expect(x.effective_from).toBe(
          limitPeriodStart(x.period_type, x.effective_from),
        );
        if (x.effective_to !== null) {
          expect(x.effective_to > x.effective_from).toBe(true);
          const next = sorted[i + 1];
          if (next) expect(x.effective_to <= next.effective_from).toBe(true);
        }
        if (x.effective_to === null && sorted[i + 1]) {
          throw new Error('open version is not the last one');
        }
      });
    };

    const apply = (
      all: LimitVersion[],
      plan: LimitPlan,
      nextId: () => string,
    ): LimitVersion[] => {
      const upd = new Map(plan.update.map((u) => [u.id, u.effective_to]));
      const del = new Set(plan.delete);
      const out = all
        .filter((x) => !del.has(x.id))
        .map((x) => ({ ...x, effective_to: upd.get(x.id) ?? x.effective_to }));
      if (plan.insert) out.push({ id: nextId(), ...plan.insert });
      return out;
    };

    it('holds over 500 random runs', () => {
      for (let run = 0; run < 500; run++) {
        const rng = makeRng(run + 1);
        let id = 0;
        const nextId = (): string => `v${String(id++)}`;
        let all: LimitVersion[] = [];
        let today = '2026-01-01';
        const steps = 1 + rng(8);
        for (let i = 0; i < steps; i++) {
          today = addDays(today, rng(200));
          if (today > '2028-12-31') today = '2028-12-31';
          const change: LimitChange =
            rng(4) === 0
              ? { kind: 'remove' }
              : {
                  kind: 'set',
                  period_type: pick(rng, TYPES),
                  amount: 100 + rng(5) * 100,
                  currency: pick(rng, CURRENCIES),
                };
          const horizon = limitPeriodStart(YEARLY, today);
          const live = all.filter(
            (x) => x.effective_to === null || x.effective_to > horizon,
          );
          const history = all.filter((x) => !live.includes(x));
          const snapshot = JSON.stringify(live);
          const plan = planLimitChange(live, change, today);
          expect(JSON.stringify(live)).toBe(snapshot);
          all = [...history, ...apply(live, plan, nextId)];
          assertInvariants(all);
        }
      }
    });
  });
});
