import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  BillDashboardQueryDto,
  BillDashboardResponseDto,
  DashboardBillSummaryDto,
  DashboardCategoryStatDto,
  DashboardCurrencySeriesDto,
  DashboardPeriodTotalDto,
} from './dto/bill-dashboard.dto';
import { Currency } from '../../types/currency.enum';

type DbConn = ReturnType<EntityManager['getConnection']>;
type PeriodRow = { currency: Currency | null; period: string; total: string };
type CategoryRow = {
  currency: Currency | null;
  category_id: string;
  category_name: string;
  total_amount: string;
};

@Injectable()
export class BillDashboardService {
  constructor(private readonly em: EntityManager) {}

  async getDashboard(
    householdId: string,
    dto: BillDashboardQueryDto,
  ): Promise<BillDashboardResponseDto> {
    const { start, end } = this.computeDateRange(dto);
    const granularity = dto.type === 'month' ? 'day' : 'month';
    const conn = this.em.getConnection();

    const [periodRows, billRows, categoryRows] = await Promise.all([
      this.fetchPeriodTotals(conn, householdId, start, end, granularity),
      this.fetchBills(conn, householdId, start, end),
      this.fetchCategoryStats(conn, householdId, start, end),
    ]);

    return {
      by_currency: this.buildCurrencySeries(
        periodRows,
        categoryRows,
        start,
        end,
        dto.type,
      ),
      bills: this.mapBills(billRows),
    };
  }

  // Amounts in different currencies are never summed: every currency (and
  // bills without one, as the null series) gets its own totals and shares.
  private buildCurrencySeries(
    periodRows: PeriodRow[],
    categoryRows: CategoryRow[],
    start: string,
    end: string,
    type: 'month' | 'quarter' | 'year',
  ): DashboardCurrencySeriesDto[] {
    const currencies = [
      ...new Set([...periodRows, ...categoryRows].map((r) => r.currency)),
    ].sort((a, b) =>
      a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0,
    );
    return currencies.map((currency) => ({
      currency,
      period_totals: this.fillGaps(
        periodRows.filter((r) => r.currency === currency),
        start,
        end,
        type,
      ),
      category_stats: this.computePercentages(
        categoryRows.filter((r) => r.currency === currency),
      ),
    }));
  }

  private computeDateRange(dto: BillDashboardQueryDto): {
    start: string;
    end: string;
  } {
    const y = dto.year;
    const pad = (n: number) => String(n).padStart(2, '0');

    if (dto.type === 'month') {
      const m = dto.month!;
      const nm = m === 12 ? 1 : m + 1;
      const ny = m === 12 ? y + 1 : y;
      return { start: `${y}-${pad(m)}-01`, end: `${ny}-${pad(nm)}-01` };
    }

    if (dto.type === 'quarter') {
      const sm = (dto.quarter! - 1) * 3 + 1;
      const endMonthRaw = sm + 3;
      const [ey, endMo] =
        endMonthRaw > 12 ? [y + 1, endMonthRaw - 12] : [y, endMonthRaw];
      return { start: `${y}-${pad(sm)}-01`, end: `${ey}-${pad(endMo)}-01` };
    }

    return { start: `${y}-01-01`, end: `${y + 1}-01-01` };
  }

  private async fetchPeriodTotals(
    conn: DbConn,
    householdId: string,
    start: string,
    end: string,
    granularity: 'day' | 'month',
  ): Promise<PeriodRow[]> {
    const SAFE_GRANULARITIES = new Set<string>(['day', 'month']);
    if (!SAFE_GRANULARITIES.has(granularity)) {
      throw new Error(`Invalid granularity: ${granularity}`);
    }
    const fmt = granularity === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
    return conn.execute(
      `SELECT currency,
              TO_CHAR(DATE_TRUNC('${granularity}', bill_date), '${fmt}') AS period,
              SUM(amount)::text AS total
       FROM bills
       WHERE household_id = ? AND status = 'confirmed'
         AND bill_date >= ? AND bill_date < ?
         AND deleted_at IS NULL
       GROUP BY currency, DATE_TRUNC('${granularity}', bill_date)
       ORDER BY period`,
      [householdId, start, end],
    ) as Promise<PeriodRow[]>;
  }

  private async fetchBills(
    conn: DbConn,
    householdId: string,
    start: string,
    end: string,
  ): Promise<
    Array<{
      id: string;
      bill_date: string;
      total_amount: string;
      currency: Currency | null;
      market_name: string | null;
      items_count: string;
    }>
  > {
    return conn.execute(
      `SELECT b.id,
              b.bill_date::text,
              b.amount::text AS total_amount,
              b.currency,
              COALESCE(m.name, b.market_name_raw) AS market_name,
              COUNT(bsc.id)::text AS items_count
       FROM bills b
       LEFT JOIN markets m ON m.id = b.market_id
       LEFT JOIN bill_sub_categories bsc ON bsc.bill_id = b.id
       WHERE b.household_id = ? AND b.status = 'confirmed'
         AND b.bill_date >= ? AND b.bill_date < ?
         AND b.deleted_at IS NULL
       GROUP BY b.id, m.name, b.market_name_raw
       ORDER BY b.bill_date DESC
       LIMIT 50`,
      [householdId, start, end],
    ) as Promise<
      Array<{
        id: string;
        bill_date: string;
        total_amount: string;
        currency: Currency | null;
        market_name: string | null;
        items_count: string;
      }>
    >;
  }

  private async fetchCategoryStats(
    conn: DbConn,
    householdId: string,
    start: string,
    end: string,
  ): Promise<CategoryRow[]> {
    return conn.execute(
      `SELECT b.currency, c.id AS category_id, c.name AS category_name,
              SUM(bsc.amount)::text AS total_amount
       FROM bill_sub_categories bsc
       JOIN bills b ON b.id = bsc.bill_id
       JOIN sub_categories sc ON sc.id = bsc.sub_category_id
       JOIN categories c ON c.id = sc.category_id
       WHERE b.household_id = ? AND b.status = 'confirmed'
         AND b.bill_date >= ? AND b.bill_date < ?
         AND b.deleted_at IS NULL
         AND bsc.sub_category_id IS NOT NULL
       GROUP BY b.currency, c.id, c.name
       ORDER BY SUM(bsc.amount) DESC, c.name`,
      [householdId, start, end],
    ) as Promise<CategoryRow[]>;
  }

  private fillGaps(
    rows: PeriodRow[],
    start: string,
    end: string,
    type: 'month' | 'quarter' | 'year',
  ): DashboardPeriodTotalDto[] {
    // Assumes `end` is always the first day of a month (guaranteed by computeDateRange).
    const rowMap = new Map(rows.map((r) => [r.period, Number(r.total)]));
    const result: DashboardPeriodTotalDto[] = [];
    const pad = (n: number) => String(n).padStart(2, '0');

    const [sy, sm] = start.split('-').map(Number);
    const [ey, endMo] = end.split('-').map(Number);

    if (type === 'month') {
      let y = sy,
        mo = sm,
        d = 1;
      while (y < ey || (y === ey && mo < endMo)) {
        const period = `${y}-${pad(mo)}-${pad(d)}`;
        result.push({ period, total: rowMap.get(period) ?? 0 });
        const next = new Date(y, mo - 1, d + 1);
        y = next.getFullYear();
        mo = next.getMonth() + 1;
        d = next.getDate();
      }
    } else {
      let y = sy,
        mo = sm;
      while (y < ey || (y === ey && mo < endMo)) {
        result.push({
          period: `${y}-${pad(mo)}`,
          total: rowMap.get(`${y}-${pad(mo)}`) ?? 0,
        });
        mo++;
        if (mo > 12) {
          mo = 1;
          y++;
        }
      }
    }

    return result;
  }

  private mapBills(
    rows: Array<{
      id: string;
      bill_date: string;
      total_amount: string;
      currency: Currency | null;
      market_name: string | null;
      items_count: string;
    }>,
  ): DashboardBillSummaryDto[] {
    return rows.map((r) => ({
      id: r.id,
      bill_date: r.bill_date.substring(0, 10),
      total_amount: Number(r.total_amount),
      currency: r.currency,
      market_name: r.market_name,
      items_count: Number(r.items_count),
    }));
  }

  private computePercentages(rows: CategoryRow[]): DashboardCategoryStatDto[] {
    if (rows.length === 0) return [];
    const totals = rows.map((r) => Number(r.total_amount));
    const sum = totals.reduce((a, v) => a + v, 0);
    return rows.map((r, i) => ({
      category_id: r.category_id,
      category_name: r.category_name,
      total_amount: totals[i],
      percentage: sum > 0 ? Math.round((totals[i] / sum) * 10000) / 100 : 0,
    }));
  }
}
