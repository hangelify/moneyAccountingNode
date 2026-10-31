import { todayIsoDate } from './calendar-date';

export const SPENDING_PERIODS = [
  'week',
  'month',
  'quarter',
  'year',
  '5y',
  'custom',
] as const;
export type SpendingPeriod = (typeof SPENDING_PERIODS)[number];

/** Longest range a `custom` period may cover. */
export const MAX_CUSTOM_RANGE_YEARS = 10;

/** A half-open `[start, end)` range of `YYYY-MM-DD` calendar days. */
export interface PeriodRange {
  period: SpendingPeriod;
  start: string;
  end: string;
}

export interface PeriodRangeInput {
  period: SpendingPeriod;
  /** Any day inside the period; defaults to the UTC day of `now`. */
  anchor?: string;
  /** Required for `custom`; `to` is inclusive. */
  from?: string;
  to?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

// All arithmetic runs on UTC midnights, so no local time zone or DST shift
// can move a day.
const parse = (d: string): Date => new Date(`${d}T00:00:00Z`);
const format = (d: Date): string =>
  `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** First day of the month `months` after (or before) year/month (1-based). */
const monthStart = (year: number, month: number, months = 0): string =>
  format(new Date(Date.UTC(year, month - 1 + months, 1)));

export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

/** Same month and day `years` later; Feb 29 becomes Feb 28 in a common year. */
export function addYears(date: string, years: number): string {
  const d = parse(date);
  const y = d.getUTCFullYear() + years;
  const m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return format(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay))));
}

/**
 * The calendar range of a spending period, as half-open `[start, end)`
 * `YYYY-MM-DD` days. `week` is the ISO week (Monday start); `5y` is the 60
 * full months ending with the anchor's month; `custom` is `from..to` with `to`
 * included.
 */
export function computePeriodRange(
  input: PeriodRangeInput,
  now: Date = new Date(),
): PeriodRange {
  const { period } = input;
  if (period === 'custom') {
    if (!input.from || !input.to) {
      throw new Error('A custom period needs both from and to');
    }
    return { period, start: input.from, end: addDays(input.to, 1) };
  }

  const anchor = input.anchor ?? todayIsoDate(now);
  const d = parse(anchor);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;

  switch (period) {
    case 'week': {
      const sinceMonday = (d.getUTCDay() + 6) % 7;
      const start = addDays(anchor, -sinceMonday);
      return { period, start, end: addDays(start, 7) };
    }
    case 'month':
      return { period, start: monthStart(y, m), end: monthStart(y, m, 1) };
    case 'quarter': {
      const q = Math.floor((m - 1) / 3) * 3 + 1;
      return { period, start: monthStart(y, q), end: monthStart(y, q, 3) };
    }
    case 'year':
      return { period, start: monthStart(y, 1), end: monthStart(y + 1, 1) };
    case '5y':
      return { period, start: monthStart(y, m, -59), end: monthStart(y, m, 1) };
  }
}
