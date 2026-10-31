import { Injectable } from '@nestjs/common';
import { Connection, EntityManager } from '@mikro-orm/core';
import { Currency } from '../../types/currency.enum';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import {
  BillExchangeRateDto,
  UnconvertedDto,
} from './dto/household-conversion.dto';

/**
 * Joins each bill of alias `bill` to its household and the factor that turns
 * its amount into the household currency, read from the saved rates.
 * Placed right after `FROM bills <bill>`; both `?` bind the rate source.
 *
 * Exposes `h.currency` (selected `AS household_currency`), `fx.factor` (NULL
 * when the bill has no currency or a needed rate is not saved) and
 * `fx.rate_date` (day of the rates used, NULL when no rate was needed).
 * A rate is the latest saved one on or before `bill_date`, so weekends and
 * unsaved days use the last published day.
 */
export function householdConversionJoin(bill = 'b'): string {
  return `
         JOIN   households h ON h.id = ${bill}.household_id
         LEFT   JOIN LATERAL (
                  SELECT er.rate, er.rate_date
                  FROM   exchange_rates er
                  WHERE  er.source = ?
                    AND  er.currency = ${bill}.currency
                    AND  er.rate_date <= ${bill}.bill_date
                    AND  ${bill}.currency <> 'MDL'
                    AND  ${bill}.currency <> h.currency
                  ORDER  BY er.rate_date DESC
                  LIMIT  1
                ) rf ON true
         LEFT   JOIN LATERAL (
                  SELECT er.rate, er.rate_date
                  FROM   exchange_rates er
                  WHERE  er.source = ?
                    AND  er.currency = h.currency
                    AND  er.rate_date <= ${bill}.bill_date
                    AND  h.currency <> 'MDL'
                    AND  ${bill}.currency <> h.currency
                  ORDER  BY er.rate_date DESC
                  LIMIT  1
                ) rt ON true
         CROSS  JOIN LATERAL (
                  SELECT CASE
                           WHEN ${bill}.currency IS NULL THEN NULL
                           WHEN ${bill}.currency = h.currency THEN 1
                           ELSE (CASE WHEN ${bill}.currency = 'MDL' THEN 1 ELSE rf.rate END)
                              / (CASE WHEN h.currency = 'MDL' THEN 1 ELSE rt.rate END)
                         END AS factor,
                         COALESCE(rf.rate_date, rt.rate_date) AS rate_date
                ) fx`;
}

/**
 * Confirmed bills in `[start, end)` that could not be converted, per original
 * currency (by code, bills without a currency last). With `currency`, only
 * bills in that currency are looked at.
 */
export async function fetchUnconverted(
  conn: Connection,
  source: string,
  householdId: string,
  start: string,
  end: string,
  currency?: Currency,
): Promise<UnconvertedDto[]> {
  const params: unknown[] = [source, source, householdId, start, end];
  if (currency) params.push(currency);
  const rows = (await conn.execute(
    `SELECT b.currency, COUNT(*)::int AS bill_count, SUM(b.amount)::text AS amount
     FROM   bills b
     ${householdConversionJoin('b')}
     WHERE  b.household_id = ?
       AND  b.status     = 'confirmed'
       AND  b.deleted_at IS NULL
       AND  b.bill_date >= ?
       AND  b.bill_date <  ?
       AND  fx.factor IS NULL
       ${currency ? 'AND  b.currency = ?' : ''}
     GROUP  BY b.currency
     ORDER  BY b.currency::text NULLS LAST`,
    params,
  )) as Array<{
    currency: Currency | null;
    bill_count: number;
    amount: string;
  }>;
  return rows.map((r) => ({
    currency: r.currency,
    bill_count: r.bill_count,
    amount: Number(r.amount),
  }));
}

/** A bill's total in its household currency and the rate behind it. */
export interface BillConversion {
  household_currency: Currency;
  household_amount: number | null;
  exchange_rate: BillExchangeRateDto | null;
}

/** Converts single bills for the detail views; never asks the provider. */
@Injectable()
export class BillConversionService {
  constructor(
    private readonly em: EntityManager,
    private readonly exchangeRates: ExchangeRateService,
  ) {}

  /** The conversion of each of `billIds` in the household, by bill id. */
  async forBills(
    householdId: string,
    billIds: string[],
  ): Promise<Map<string, BillConversion>> {
    if (billIds.length === 0) return new Map();
    const source = this.exchangeRates.source;
    const rows = (await this.em.getConnection().execute(
      `SELECT b.id, h.currency AS household_currency,
              ROUND(b.amount * fx.factor, 2)::text AS household_amount,
              ROUND(fx.factor, 6)::text AS rate,
              fx.rate_date::text AS rate_date
       FROM   bills b
       ${householdConversionJoin('b')}
       WHERE  b.household_id = ?
         AND  b.id = ANY(?::uuid[])`,
      [source, source, householdId, `{${billIds.join(',')}}`],
    )) as Array<{
      id: string;
      household_currency: Currency;
      household_amount: string | null;
      rate: string | null;
      rate_date: string | null;
    }>;
    return new Map(
      rows.map((r) => [
        r.id,
        {
          household_currency: r.household_currency,
          household_amount:
            r.household_amount === null ? null : Number(r.household_amount),
          // No rate_date: same currency, so no rate was used.
          exchange_rate:
            r.rate !== null && r.rate_date !== null
              ? { rate: Number(r.rate), rate_date: r.rate_date }
              : null,
        },
      ]),
    );
  }
}
