import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type {
  SpendingBreakdownQueryDto,
  SpendingBreakdownResponseDto,
} from './dto/spending-breakdown.dto';
import { computePeriodRange } from '../../common/utils/period-range';
import { foldSpendingRows, type SpendingRow } from './spending-breakdown';

@Injectable()
export class SpendingBreakdownService {
  constructor(private readonly em: EntityManager) {}

  async getSpendingBreakdown(
    householdId: string,
    dto: SpendingBreakdownQueryDto,
  ): Promise<SpendingBreakdownResponseDto> {
    const range = computePeriodRange(dto);
    const params: unknown[] = [householdId, range.start, range.end];
    if (dto.currency) params.push(dto.currency);

    // Aggregate the lines per (currency, sub-category) first, then join the
    // names onto the few aggregated rows. Deleted categories and
    // sub-categories still join, so past spending keeps its labels.
    const rows = await this.em
      .fork()
      .transactional(async (tx): Promise<SpendingRow[]> => {
        const conn = tx.getConnection();
        // A 5-year range hashes many groups; keep the sort in memory.
        await conn.execute(
          `SET LOCAL work_mem = '16MB'`,
          [],
          'run',
          tx.getTransactionContext(),
        );
        return (await conn.execute(
          `WITH agg AS (
           SELECT b.currency, l.sub_category_id,
                  SUM(l.amount) AS total, COUNT(*) AS lines
           FROM bills b
           JOIN bill_sub_categories l ON l.bill_id = b.id
           WHERE b.household_id = ? AND b.status = 'confirmed'
             AND b.deleted_at IS NULL
             AND b.bill_date >= ? AND b.bill_date < ?
             ${dto.currency ? 'AND b.currency = ?' : ''}
           GROUP BY b.currency, l.sub_category_id
         )
         SELECT agg.currency, agg.sub_category_id,
                agg.total::text AS total, agg.lines::text AS lines,
                sc.name AS sub_name, c.id AS category_id,
                c.name AS category_name,
                (c.deleted_at IS NOT NULL) AS category_archived,
                (c.deleted_at IS NOT NULL OR sc.deleted_at IS NOT NULL) AS archived
         FROM agg
         LEFT JOIN sub_categories sc ON sc.id = agg.sub_category_id
         LEFT JOIN categories c ON c.id = sc.category_id`,
          params,
          'all',
          tx.getTransactionContext(),
        )) as SpendingRow[];
      });

    return { range, by_currency: foldSpendingRows(rows) };
  }
}
