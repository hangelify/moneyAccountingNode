import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type {
  SpendingBreakdownQueryDto,
  SpendingBreakdownResponseDto,
} from './dto/spending-breakdown.dto';
import { computePeriodRange } from '../../common/utils/period-range';
import { foldSpendingRows, type SpendingRow } from './spending-breakdown';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import {
  fetchUnconverted,
  householdConversionJoin,
  loadRateDays,
} from './household-conversion';

// Names joined onto the aggregated rows (CTE `agg`) by both queries. The
// category is the line's own, so lines without a sub-category keep theirs.
const JOIN_NAMES = `SELECT agg.currency, agg.sub_category_id,
                agg.total::text AS total, agg.lines::text AS lines,
                sc.name AS sub_name, c.id AS category_id,
                c.name AS category_name,
                (c.deleted_at IS NOT NULL) AS category_archived,
                (c.deleted_at IS NOT NULL OR sc.deleted_at IS NOT NULL) AS archived
         FROM agg
         LEFT JOIN sub_categories sc ON sc.id = agg.sub_category_id
         LEFT JOIN categories c ON c.id = agg.category_id`;

@Injectable()
export class SpendingBreakdownService {
  constructor(
    private readonly em: EntityManager,
    private readonly exchangeRates: ExchangeRateService,
  ) {}

  async getSpendingBreakdown(
    householdId: string,
    dto: SpendingBreakdownQueryDto,
  ): Promise<SpendingBreakdownResponseDto> {
    const range = computePeriodRange(dto);
    const params: unknown[] = [householdId, range.start, range.end];
    if (dto.currency) params.push(dto.currency);

    // Rates first, so the converted query sees the days just saved.
    const householdCurrency = await loadRateDays(
      this.em.getConnection(),
      this.exchangeRates,
      householdId,
      range.start,
      range.end,
      dto.currency,
    );
    const source = this.exchangeRates.source;

    // Aggregate the lines per (currency, category, sub-category) first, then
    // join the names onto the few aggregated rows. Deleted categories and
    // sub-categories still join, so past spending keeps its labels.
    const { rows, convertedRows, unconverted } = await this.em
      .fork()
      .transactional(async (tx) => {
        const conn = tx.getConnection();
        // A 5-year range hashes many groups; keep the sort in memory.
        await conn.execute(
          `SET LOCAL work_mem = '16MB'`,
          [],
          'run',
          tx.getTransactionContext(),
        );
        const rows = (await conn.execute(
          `WITH agg AS (
           SELECT b.currency, l.category_id, l.sub_category_id,
                  SUM(l.amount) AS total, COUNT(*) AS lines
           FROM bills b
           JOIN bill_sub_categories l ON l.bill_id = b.id
           WHERE b.household_id = ? AND b.status = 'confirmed'
             AND b.deleted_at IS NULL
             AND b.bill_date >= ? AND b.bill_date < ?
             ${dto.currency ? 'AND b.currency = ?' : ''}
           GROUP BY b.currency, l.category_id, l.sub_category_id
         )
         ${JOIN_NAMES}`,
          params,
          'all',
          tx.getTransactionContext(),
        )) as SpendingRow[];

        // Same lines, converted and summed per category and sub-category,
        // rounded once.
        const convertedRows = (await conn.execute(
          `WITH agg AS (
           SELECT h.currency, l.category_id, l.sub_category_id,
                  ROUND(SUM(l.amount * fx.factor), 2) AS total,
                  COUNT(*) AS lines
           FROM bills b
           ${householdConversionJoin('b')}
           JOIN bill_sub_categories l ON l.bill_id = b.id
           WHERE b.household_id = ? AND b.status = 'confirmed'
             AND b.deleted_at IS NULL
             AND b.bill_date >= ? AND b.bill_date < ?
             AND fx.factor IS NOT NULL
             ${dto.currency ? 'AND b.currency = ?' : ''}
           GROUP BY h.currency, l.category_id, l.sub_category_id
         )
         ${JOIN_NAMES}`,
          [source, source, ...params],
          'all',
          tx.getTransactionContext(),
        )) as SpendingRow[];

        const unconverted = await fetchUnconverted(
          conn,
          source,
          householdId,
          range.start,
          range.end,
          dto.currency,
          tx.getTransactionContext(),
        );
        return { rows, convertedRows, unconverted };
      });

    // One household currency, so the fold yields one tree, or none.
    const [tree] = foldSpendingRows(convertedRows);
    return {
      range,
      by_currency: foldSpendingRows(rows),
      in_household_currency: {
        ...(tree ?? {
          currency: householdCurrency,
          total: 0,
          lines: 0,
          categories: [],
        }),
        unconverted,
      },
    };
  }
}
