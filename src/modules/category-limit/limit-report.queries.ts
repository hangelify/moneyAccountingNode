import { EntityManager } from '@mikro-orm/core';
import { Currency } from '../../types/currency.enum';
import { LimitPeriodType } from '../../types/limit-period-type.enum';
import { currencyFactorLateral, householdConversionJoin } from '../bill';
import type { CarryStop, ReportVersion, SpentRow } from './limit-report';

// SQL reads of the limits report (HAN-25), each in the caller's transaction.

// Start of the period of the report's type containing `b.bill_date`. Chosen
// by the enum in code, never built from input. `::timestamp` keeps the
// session time zone out of date_trunc.
const BUCKET: Record<LimitPeriodType, string> = {
  [LimitPeriodType.MONTHLY]: `date_trunc('month', b.bill_date::timestamp)::date`,
  [LimitPeriodType.QUARTERLY]: `date_trunc('quarter', b.bill_date::timestamp)::date`,
  [LimitPeriodType.YEARLY]: `date_trunc('year', b.bill_date::timestamp)::date`,
  [LimitPeriodType.SEMI_ANNUAL]: `make_date(extract(year from b.bill_date)::int,
                    CASE WHEN extract(month from b.bill_date) <= 6 THEN 1 ELSE 7 END, 1)`,
};

export interface VersionRow extends ReportVersion {
  name: string;
  archived: boolean;
}

/** What the report reads before any rate is needed. */
export interface Limits {
  versions: VersionRow[];
  stops: CarryStop[];
  limitedCategoryIds: Set<string>;
}

/** A base limit to convert: one chain period of a foreign-currency version. */
export interface BaseLimitKey {
  key: string;
  amount: string;
  currency: Currency;
  day: string;
}

/** Runs a read in the transaction of `tx`. */
const query = <T>(
  tx: EntityManager,
  sql: string,
  params: unknown[],
): Promise<T[]> =>
  tx
    .getConnection()
    .execute(sql, params, 'all', tx.getTransactionContext()) as Promise<T[]>;

/** Postgres array literal of plain values (no quotes or backslashes). */
const pgArray = (values: string[]): string =>
  '{' + values.map((v) => '"' + v + '"').join(',') + '}';

/**
 * Versions of `type` starting before `end` with their category, the
 * "do not carry over" marks of `type` up to `start`, and the categories with
 * a version of any type overlapping `[start, end)`.
 */
export async function readLimits(
  tx: EntityManager,
  scope: { householdId: string; type: LimitPeriodType },
  range: { start: string; end: string },
): Promise<Limits> {
  const { householdId, type } = scope;
  const { start, end } = range;
  const versions = await query<VersionRow>(
    tx,
    `SELECT cl.id, cl.category_id, cl.amount::text AS amount, cl.currency,
            cl.effective_from::text AS effective_from,
            cl.effective_to::text AS effective_to,
            c.name, (c.deleted_at IS NOT NULL) AS archived
     FROM   category_limits cl
     JOIN   categories c ON c.id = cl.category_id
     WHERE  cl.household_id = ? AND cl.period_type = ? AND cl.effective_from < ?`,
    [householdId, type, end],
  );
  const stops = await query<CarryStop>(
    tx,
    `SELECT category_id, period_start::text AS period_start
     FROM   category_limit_carry_stops
     WHERE  household_id = ? AND period_type = ? AND period_start <= ?`,
    [householdId, type, start],
  );
  const limited = await query<{ category_id: string }>(
    tx,
    `SELECT DISTINCT category_id
     FROM   category_limits
     WHERE  household_id = ? AND effective_from < ?
       AND  (effective_to IS NULL OR effective_to > ?)`,
    [householdId, end, start],
  );
  return {
    versions,
    stops,
    limitedCategoryIds: new Set(limited.map((r) => r.category_id)),
  };
}

/** The household currency, read in the transaction of `tx`. */
export async function readCurrency(
  tx: EntityManager,
  householdId: string,
): Promise<Currency> {
  const [row] = await query<{ currency: Currency }>(
    tx,
    `SELECT currency FROM households WHERE id = ?`,
    [householdId],
  );
  if (!row) throw new Error(`Household ${householdId} not found`);
  return row.currency;
}

/** Each foreign base limit converted at the rate of its day, in one query. */
export async function convertBaseLimits(
  tx: EntityManager,
  scope: { source: string; householdId: string },
  keys: BaseLimitKey[],
): Promise<Map<string, string | null>> {
  if (keys.length === 0) return new Map();
  const rows = await query<{ key: string; value: string | null }>(
    tx,
    `SELECT k.key, ROUND(k.amount * f.factor, 2)::text AS value
     FROM   unnest(?::text[], ?::numeric[], ?::currency_enum[], ?::date[])
              AS k(key, amount, currency, day)
     JOIN   households h ON h.id = ?
     ${currencyFactorLateral('k.currency', 'h.currency', 'k.day', 'f')}`,
    [
      pgArray(keys.map((k) => k.key)),
      pgArray(keys.map((k) => k.amount)),
      pgArray(keys.map((k) => k.currency)),
      pgArray(keys.map((k) => k.day)),
      scope.householdId,
      scope.source,
      scope.source,
    ],
  );
  return new Map(rows.map((r) => [r.key, r.value]));
}

/**
 * Converted spending per (category, sub-category, period of `type`) in
 * `[start, end)`, rounded per group as the spending breakdown does, with the
 * number of lines that had no rate.
 */
export function fetchSpent(
  tx: EntityManager,
  scope: { source: string; householdId: string; type: LimitPeriodType },
  range: { start: string; end: string },
): Promise<SpentRow[]> {
  const bucket = BUCKET[scope.type];
  return query<SpentRow>(
    tx,
    `SELECT l.category_id,
            ${bucket}::text AS bucket,
            COALESCE(ROUND(SUM(l.amount * fx.factor), 2), 0)::text AS total,
            (COUNT(*) FILTER (WHERE fx.factor IS NULL))::int AS unconverted_lines
     FROM   bills b
     ${householdConversionJoin('b')}
     JOIN   bill_sub_categories l ON l.bill_id = b.id
     WHERE  b.household_id = ?
       AND  b.status = 'confirmed'
       AND  b.deleted_at IS NULL
       AND  b.bill_date >= ?
       AND  b.bill_date <  ?
     GROUP  BY l.category_id, l.sub_category_id, ${bucket}`,
    [scope.source, scope.source, scope.householdId, range.start, range.end],
  );
}
