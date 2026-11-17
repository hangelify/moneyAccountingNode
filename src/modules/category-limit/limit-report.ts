import { Currency } from '../../types/currency.enum';
import { LimitPeriodType } from '../../types/limit-period-type.enum';
import { addDays, limitPeriodStart } from '../../common/utils/period-range';
import type { UnconvertedDto } from '../bill';

/** A limit version of the report's period type with `effective_from < end`. */
export interface ReportVersion {
  id: string;
  category_id: string;
  amount: string;
  currency: Currency;
  effective_from: string;
  effective_to: string | null;
}

/** A "do not carry over" mark on the period starting at `period_start`. */
export interface CarryStop {
  category_id: string;
  period_start: string;
}

export interface ChainPeriod {
  period_start: string;
  version: ReportVersion;
}

export interface ReportCategoryInfo {
  category_id: string;
  name: string;
  archived: boolean;
}

/** One aggregate row: spending of a (category, sub-category, period) bucket. */
export interface SpentRow {
  category_id: string | null;
  bucket: string;
  /** Decimal string in household currency, already rounded to cents. */
  total: string;
  unconverted_lines: number;
}

export interface LimitReportInput {
  type: LimitPeriodType;
  start: string;
  end: string;
  currency: Currency;
  chains: Map<string, ChainPeriod[]>;
  categories: Map<string, ReportCategoryInfo>;
  /** Base limit in household currency per `${version.id}|${period_start}`; null = no rate. */
  baseLimits: Map<string, string | null>;
  /** Buckets in `[chainStart, end)`. */
  spent: SpentRow[];
  stops: CarryStop[];
  /** Categories with a version of any type overlapping `[start, end)`. */
  limitedCategoryIds: Set<string>;
  unconverted: UnconvertedDto[];
}

export interface LimitReportCategory {
  category_id: string;
  category_name: string;
  category_archived: boolean;
  limit_id: string;
  limit_amount: number;
  limit_currency: Currency;
  base_limit: number | null;
  carried_in: number;
  limit: number | null;
  spent: number;
  remaining: number | null;
  percent: number | null;
  carry_over: boolean;
  carry_incomplete: boolean;
  unconverted_lines: number;
}

export interface LimitReportTotal {
  base_limit: number;
  carried_in: number;
  limit: number;
  spent: number;
  remaining: number;
  percent: number | null;
}

export interface LimitReport {
  period_type: LimitPeriodType;
  start: string;
  end: string;
  currency: Currency;
  categories: LimitReportCategory[];
  total: LimitReportTotal;
  other_spent: number;
  unconverted: UnconvertedDto[];
}

const key = (a: string, b: string): string => `${a}|${b}`;
const toCents = (v: string): number => Math.round(Number(v) * 100);
const fromCents = (c: number): number => c / 100;

const covers = (v: ReportVersion, day: string): boolean =>
  v.effective_from <= day && (v.effective_to === null || v.effective_to > day);

const previousPeriod = (type: LimitPeriodType, start: string): string =>
  limitPeriodStart(type, addDays(start, -1));

const stopKeys = (stops: CarryStop[]): Set<string> =>
  new Set(stops.map((s) => key(s.category_id, s.period_start)));

/**
 * Chain periods of each category, from its first period up to `start`, in
 * ascending order. Only categories with a version in `start` get a key. A stop
 * on period P ends the chain before P + 1; a stop on `start` has no effect.
 */
export function chainPeriods(
  type: LimitPeriodType,
  start: string,
  versions: ReportVersion[],
  stops: CarryStop[],
): Map<string, ChainPeriod[]> {
  const stopped = stopKeys(stops);
  const byCategory = new Map<string, ReportVersion[]>();
  for (const v of versions) {
    const own = byCategory.get(v.category_id) ?? [];
    own.push(v);
    byCategory.set(v.category_id, own);
  }

  const chains = new Map<string, ChainPeriod[]>();
  for (const [categoryId, own] of byCategory) {
    const chain: ChainPeriod[] = [];
    let p = start;
    let version = own.find((v) => covers(v, p));
    while (version) {
      chain.unshift({ period_start: p, version });
      p = previousPeriod(type, p);
      version = stopped.has(key(categoryId, p))
        ? undefined
        : own.find((v) => covers(v, p));
    }
    if (chain.length > 0) chains.set(categoryId, chain);
  }
  return chains;
}

interface PeriodFact {
  spent: number;
  unconverted: number;
}

const NO_FACT: PeriodFact = { spent: 0, unconverted: 0 };

/** Spending in cents and unconverted lines per `${category_id}|${bucket}`. */
function periodFacts(rows: SpentRow[]): Map<string, PeriodFact> {
  const facts = new Map<string, PeriodFact>();
  for (const row of rows) {
    if (row.category_id === null) continue;
    const k = key(row.category_id, row.bucket);
    const fact = facts.get(k) ?? { spent: 0, unconverted: 0 };
    fact.spent += toCents(row.total);
    fact.unconverted += row.unconverted_lines;
    facts.set(k, fact);
  }
  return facts;
}

/** The report period of a chain, in cents. */
interface Folded {
  version: ReportVersion;
  base: number | null;
  carriedIn: number;
  fact: PeriodFact;
  incomplete: boolean;
}

interface FoldContext {
  baseLimits: Map<string, string | null>;
  facts: Map<string, PeriodFact>;
  stopped: Set<string>;
}

/** Base limit of a chain period in cents; a missing entry counts as no rate. */
function baseOf(ctx: FoldContext, p: ChainPeriod): number | null {
  const base = ctx.baseLimits.get(key(p.version.id, p.period_start));
  return base == null ? null : toCents(base);
}

/** Walks the chain carrying each period's remainder into the next one. */
function foldChain(
  categoryId: string,
  chain: ChainPeriod[],
  ctx: FoldContext,
): Folded {
  let carry = 0;
  let incomplete = false;
  for (const p of chain.slice(0, -1)) {
    const base = baseOf(ctx, p);
    const fact = ctx.facts.get(key(categoryId, p.period_start)) ?? NO_FACT;
    const stopped = ctx.stopped.has(key(categoryId, p.period_start));
    carry = base === null || stopped ? 0 : base + carry - fact.spent;
    incomplete ||= base === null || fact.unconverted > 0;
  }
  const last = chain.at(-1);
  if (!last) throw new Error(`Empty limit chain for ${categoryId}`);
  return {
    version: last.version,
    base: baseOf(ctx, last),
    carriedIn: carry,
    fact: ctx.facts.get(key(categoryId, last.period_start)) ?? NO_FACT,
    incomplete,
  };
}

/** `spent / limit` in percent with 2 decimals; null unless the limit is positive. */
const percentOf = (spent: number, limit: number | null): number | null =>
  limit === null || limit <= 0
    ? null
    : Math.round((spent / limit) * 10000) / 100;

const centsOrNull = (c: number | null): number | null =>
  c === null ? null : fromCents(c);

function categoryRow(
  info: ReportCategoryInfo,
  folded: Folded,
  carryOver: boolean,
): LimitReportCategory {
  const { version, base, carriedIn, fact } = folded;
  const limit = base === null ? null : base + carriedIn;
  return {
    category_id: info.category_id,
    category_name: info.name,
    category_archived: info.archived,
    limit_id: version.id,
    limit_amount: Number(version.amount),
    limit_currency: version.currency,
    base_limit: centsOrNull(base),
    carried_in: fromCents(carriedIn),
    limit: centsOrNull(limit),
    spent: fromCents(fact.spent),
    remaining: centsOrNull(limit === null ? null : limit - fact.spent),
    percent: percentOf(fact.spent, limit),
    carry_over: carryOver,
    carry_incomplete: folded.incomplete,
    unconverted_lines: fact.unconverted,
  };
}

/** Totals over categories with a convertible base limit. */
function totalOf(rows: LimitReportCategory[]): LimitReportTotal {
  const counted = rows.filter((r) => r.base_limit !== null);
  const sum = (pick: (r: LimitReportCategory) => number): number =>
    counted.reduce((acc, r) => acc + Math.round(pick(r) * 100), 0);
  const base = sum((r) => r.base_limit ?? 0);
  const carriedIn = sum((r) => r.carried_in);
  const spent = sum((r) => r.spent);
  return {
    base_limit: fromCents(base),
    carried_in: fromCents(carriedIn),
    limit: fromCents(base + carriedIn),
    spent: fromCents(spent),
    remaining: fromCents(base + carriedIn - spent),
    percent: percentOf(spent, base + carriedIn),
  };
}

/** Spending in `start` without a category or of categories without any limit. */
function otherSpent(input: LimitReportInput): number {
  const cents = input.spent
    .filter(
      (r) =>
        r.bucket === input.start &&
        (r.category_id === null ||
          !input.limitedCategoryIds.has(r.category_id)),
    )
    .reduce((acc, r) => acc + toCents(r.total), 0);
  return fromCents(cents);
}

const byNameThenId = (a: LimitReportCategory, b: LimitReportCategory): number =>
  a.category_name.localeCompare(b.category_name) ||
  a.category_id.localeCompare(b.category_id);

/** Folds versions, stops and spending into the report of period `start`. */
export function buildLimitReport(input: LimitReportInput): LimitReport {
  const ctx: FoldContext = {
    baseLimits: input.baseLimits,
    facts: periodFacts(input.spent),
    stopped: stopKeys(input.stops),
  };

  const categories: LimitReportCategory[] = [];
  for (const [categoryId, chain] of input.chains) {
    const info = input.categories.get(categoryId);
    if (!info) throw new Error(`No category info for ${categoryId}`);
    categories.push(
      categoryRow(
        info,
        foldChain(categoryId, chain, ctx),
        !ctx.stopped.has(key(categoryId, input.start)),
      ),
    );
  }
  categories.sort(byNameThenId);

  return {
    period_type: input.type,
    start: input.start,
    end: input.end,
    currency: input.currency,
    categories,
    total: totalOf(categories),
    other_spent: otherSpent(input),
    unconverted: input.unconverted,
  };
}
