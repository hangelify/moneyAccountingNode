import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  BillDashboardQueryDto,
  BillDashboardResponseDto,
  DashboardBillSummaryDto,
  DashboardCategoryStatDto,
  DashboardCurrencySeriesDto,
  DashboardHouseholdSeriesDto,
  DashboardPeriodTotalDto,
} from './dto/bill-dashboard.dto';
import { UnconvertedDto } from './dto/household-conversion.dto';
import { Currency } from '../../types/currency.enum';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import {
  fetchUnconverted,
  householdConversionJoin,
  loadRateDays,
} from './household-conversion';

type DbConn = ReturnType<EntityManager['getConnection']>;
type PeriodRow = { currency: Currency | null; period: string; total: string };
type CategoryRow = {
  currency: Currency | null;
  category_id: string;
  category_name: string;
  total_amount: string;
};
type BillRow = {
  id: string;
  bill_date: string;
  total_amount: string;
  household_amount: string | null;
  currency: Currency | null;
  market_name: string | null;
  items_count: string;
};

@Injectable()
export class BillDashboardService {
  constructor(
    private readonly em: EntityManager,
    private readonly exchangeRates: ExchangeRateService,
  ) {}

  async getDashboard(
    householdId: string,
    dto: BillDashboardQueryDto,
  ): Promise<BillDashboardResponseDto> {
    const { start, end } = this.computeDateRange(dto);
    const granularity = dto.type === 'month' ? 'day' : 'month';
    const conn = this.em.getConnection();
    const source = this.exchangeRates.source;

    // Rates first, so the queries below see the days just saved.
    const householdCurrency = await loadRateDays(
      conn,
      this.exchangeRates,
      householdId,
      start,
      end,
    );

    const [
      periodRows,
      billRows,
      categoryRows,
      convertedPeriodRows,
      convertedCategoryRows,
      unconverted,
    ] = await Promise.all([
      this.fetchPeriodTotals(conn, householdId, start, end, granularity),
      this.fetchBills(conn, source, householdId, start, end),
      this.fetchCategoryStats(conn, householdId, start, end),
      this.fetchConvertedPeriodTotals(
        conn,
        source,
        householdId,
        start,
        end,
        granularity,
      ),
      this.fetchConvertedCategoryStats(conn, source, householdId, start, end),
      fetchUnconverted(conn, source, householdId, start, end),
    ]);

    return {
      by_currency: this.buildCurrencySeries(
        periodRows,
        categoryRows,
        start,
        end,
        dto.type,
      ),
      in_household_currency: this.buildHouseholdSeries(
        householdCurrency,
        convertedPeriodRows,
        convertedCategoryRows,
        unconverted,
        start,
        end,
        dto.type,
      ),
      bills: this.mapBills(billRows),
    };
  }

  // One series of every convertible bill; the rest is listed as unconverted.
  private buildHouseholdSeries(
    currency: Currency,
    periodRows: PeriodRow[],
    categoryRows: CategoryRow[],
    unconverted: UnconvertedDto[],
    start: string,
    end: string,
    type: 'month' | 'quarter' | 'year',
  ): DashboardHouseholdSeriesDto {
    return {
      currency,
      period_totals: this.fillGaps(periodRows, start, end, type),
      category_stats: this.computePercentages(categoryRows),
      unconverted,
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
    source: string,
    householdId: string,
    start: string,
    end: string,
  ): Promise<BillRow[]> {
    return conn.execute(
      `SELECT b.id,
              b.bill_date::text,
              b.amount::text AS total_amount,
              ROUND(b.amount * fx.factor, 2)::text AS household_amount,
              b.currency,
              COALESCE(m.name, b.market_name_raw) AS market_name,
              COUNT(bsc.id)::text AS items_count
       FROM bills b
       ${householdConversionJoin('b')}
       LEFT JOIN markets m ON m.id = b.market_id
       LEFT JOIN bill_sub_categories bsc ON bsc.bill_id = b.id
       WHERE b.household_id = ? AND b.status = 'confirmed'
         AND b.bill_date >= ? AND b.bill_date < ?
         AND b.deleted_at IS NULL
       GROUP BY b.id, m.name, b.market_name_raw, fx.factor
       ORDER BY b.bill_date DESC
       LIMIT 50`,
      [source, source, householdId, start, end],
    ) as Promise<BillRow[]>;
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

  // Same totals as fetchPeriodTotals, every bill converted into the
  // household currency; bills that can't be are left to fetchUnconverted.
  private async fetchConvertedPeriodTotals(
    conn: DbConn,
    source: string,
    householdId: string,
    start: string,
    end: string,
    granularity: 'day' | 'month',
  ): Promise<PeriodRow[]> {
    if (granularity !== 'day' && granularity !== 'month') {
      throw new Error(`Invalid granularity: ${granularity as string}`);
    }
    const fmt = granularity === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
    return conn.execute(
      `SELECT h.currency,
              TO_CHAR(DATE_TRUNC('${granularity}', b.bill_date), '${fmt}') AS period,
              ROUND(SUM(b.amount * fx.factor), 2)::text AS total
       FROM bills b
       ${householdConversionJoin('b')}
       WHERE b.household_id = ? AND b.status = 'confirmed'
         AND b.bill_date >= ? AND b.bill_date < ?
         AND b.deleted_at IS NULL
         AND fx.factor IS NOT NULL
       GROUP BY h.currency, DATE_TRUNC('${granularity}', b.bill_date)
       ORDER BY period`,
      [source, source, householdId, start, end],
    ) as Promise<PeriodRow[]>;
  }

  // Lines are converted, then summed and rounded once.
  private async fetchConvertedCategoryStats(
    conn: DbConn,
    source: string,
    householdId: string,
    start: string,
    end: string,
  ): Promise<CategoryRow[]> {
    return conn.execute(
      `SELECT h.currency, c.id AS category_id, c.name AS category_name,
              ROUND(SUM(bsc.amount * fx.factor), 2)::text AS total_amount
       FROM bills b
       ${householdConversionJoin('b')}
       JOIN bill_sub_categories bsc ON bsc.bill_id = b.id
       JOIN sub_categories sc ON sc.id = bsc.sub_category_id
       JOIN categories c ON c.id = sc.category_id
       WHERE b.household_id = ? AND b.status = 'confirmed'
         AND b.bill_date >= ? AND b.bill_date < ?
         AND b.deleted_at IS NULL
         AND bsc.sub_category_id IS NOT NULL
         AND fx.factor IS NOT NULL
       GROUP BY h.currency, c.id, c.name
       ORDER BY ROUND(SUM(bsc.amount * fx.factor), 2) DESC, c.name`,
      [source, source, householdId, start, end],
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

  private mapBills(rows: BillRow[]): DashboardBillSummaryDto[] {
    return rows.map((r) => ({
      id: r.id,
      bill_date: r.bill_date.substring(0, 10),
      total_amount: Number(r.total_amount),
      household_amount:
        r.household_amount === null ? null : Number(r.household_amount),
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
