import { EntityManager } from '@mikro-orm/core';
import { BillDashboardService } from './bill-dashboard.service';
import {
  BillDashboardQueryDto,
  BillDashboardResponseDto,
} from './dto/bill-dashboard.dto';

function makeService() {
  const conn = { execute: jest.fn() };
  const em = {
    getConnection: jest.fn().mockReturnValue(conn),
  } as unknown as EntityManager;
  return { service: new BillDashboardService(em), conn };
}

const userId = 'user-1';

function series(
  result: BillDashboardResponseDto,
  currency: string | null = 'EUR',
) {
  const s = result.by_currency.find((c) => c.currency === currency);
  if (!s) throw new Error(`no ${currency} series`);
  return s;
}

describe('BillDashboardService', () => {
  describe('getDashboard — month view', () => {
    it('fills all 30 days of April; zero-fills missing days', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([
          { currency: 'EUR', period: '2026-04-15', total: '1192.21' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const dto: BillDashboardQueryDto = {
        type: 'month',
        year: 2026,
        month: 4,
      };
      const result = await service.getDashboard(userId, dto);

      expect(series(result).period_totals).toHaveLength(30);
      expect(
        series(result).period_totals.find((p) => p.period === '2026-04-15')
          ?.total,
      ).toBeCloseTo(1192.21);
      expect(
        series(result).period_totals.find((p) => p.period === '2026-04-01')
          ?.total,
      ).toBe(0);
      expect(
        series(result).period_totals.find((p) => p.period === '2026-04-30')
          ?.total,
      ).toBe(0);
    });

    it('returns 28 entries for February in a non-leap year', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([
          { currency: 'EUR', period: '2026-02-10', total: '1' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const dto: BillDashboardQueryDto = {
        type: 'month',
        year: 2026,
        month: 2,
      };
      const result = await service.getDashboard(userId, dto);

      expect(series(result).period_totals).toHaveLength(28);
      expect(series(result).period_totals[0].period).toBe('2026-02-01');
      expect(series(result).period_totals[27].period).toBe('2026-02-28');
    });

    it('returns 31 entries for January', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([
          { currency: 'EUR', period: '2026-01-10', total: '1' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const dto: BillDashboardQueryDto = {
        type: 'month',
        year: 2026,
        month: 1,
      };
      const result = await service.getDashboard(userId, dto);

      expect(series(result).period_totals).toHaveLength(31);
      expect(series(result).period_totals[30].period).toBe('2026-01-31');
    });
  });

  describe('getDashboard — quarter view', () => {
    it('returns 3 monthly entries for Q2; fills gap in May', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([
          { currency: 'EUR', period: '2026-04', total: '3000' },
          { currency: 'EUR', period: '2026-06', total: '2500' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const dto: BillDashboardQueryDto = {
        type: 'quarter',
        year: 2026,
        quarter: 2,
      };
      const result = await service.getDashboard(userId, dto);

      expect(series(result).period_totals).toHaveLength(3);
      expect(series(result).period_totals[1].period).toBe('2026-05');
      expect(series(result).period_totals[1].total).toBe(0);
    });
  });

  describe('getDashboard — year view', () => {
    it('returns 12 monthly entries', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([
          { currency: 'EUR', period: '2026-05', total: '1' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const dto: BillDashboardQueryDto = { type: 'year', year: 2026 };
      const result = await service.getDashboard(userId, dto);

      expect(series(result).period_totals).toHaveLength(12);
      expect(series(result).period_totals[0].period).toBe('2026-01');
      expect(series(result).period_totals[11].period).toBe('2026-12');
    });
  });

  describe('getDashboard — category_stats', () => {
    it('computes percentages from category totals', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            currency: 'EUR',
            category_id: 'cat-1',
            category_name: 'Dairy',
            total_amount: '450',
          },
          {
            currency: 'EUR',
            category_id: 'cat-2',
            category_name: 'Meat & Fish',
            total_amount: '550',
          },
        ]);

      const dto: BillDashboardQueryDto = {
        type: 'month',
        year: 2026,
        month: 4,
      };
      const result = await service.getDashboard(userId, dto);

      expect(series(result).category_stats[0].percentage).toBeCloseTo(45);
      expect(series(result).category_stats[1].percentage).toBeCloseTo(55);
    });

    it('returns [] when a currency has no categorized spending', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([
          { currency: 'EUR', period: '2026-04-10', total: '1' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getDashboard(userId, {
        type: 'month',
        year: 2026,
        month: 4,
      });
      expect(series(result).category_stats).toEqual([]);
    });

    it('returns 0% for all categories when all amounts are zero', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            currency: 'EUR',
            category_id: 'cat-1',
            category_name: 'Dairy',
            total_amount: '0',
          },
        ]);

      const result = await service.getDashboard(userId, {
        type: 'month',
        year: 2026,
        month: 4,
      });
      expect(series(result).category_stats[0].percentage).toBe(0);
    });
  });

  describe('getDashboard — bills', () => {
    it('maps raw DB row to DashboardBillSummaryDto with numeric casts', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'bill-1',
            bill_date: '2026-04-15',
            total_amount: '1192.21',
            currency: 'MDL',
            market_name: 'Nr.1 SUPERMARKET',
            items_count: '25',
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getDashboard(userId, {
        type: 'month',
        year: 2026,
        month: 4,
      });

      expect(result.bills[0]).toEqual({
        id: 'bill-1',
        bill_date: '2026-04-15',
        total_amount: 1192.21,
        currency: 'MDL',
        market_name: 'Nr.1 SUPERMARKET',
        items_count: 25,
      });
    });
  });
  describe('getDashboard — by_currency', () => {
    it('keeps each currency in its own series, sorted, null last', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([
          { currency: null, period: '2026-04', total: '30' },
          { currency: 'MDL', period: '2026-04', total: '200' },
          { currency: 'EUR', period: '2026-05', total: '20' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            currency: 'MDL',
            category_id: 'c1',
            category_name: 'Food',
            total_amount: '150',
          },
          {
            currency: 'EUR',
            category_id: 'c2',
            category_name: 'Home',
            total_amount: '20',
          },
          {
            currency: 'MDL',
            category_id: 'c2',
            category_name: 'Home',
            total_amount: '50',
          },
        ]);

      const result = await service.getDashboard(userId, {
        type: 'quarter',
        year: 2026,
        quarter: 2,
      });

      expect(result.by_currency.map((s) => s.currency)).toEqual([
        'EUR',
        'MDL',
        null,
      ]);
      expect(series(result, 'MDL').period_totals.map((p) => p.total)).toEqual([
        200, 0, 0,
      ]);
      expect(series(result, 'EUR').period_totals.map((p) => p.total)).toEqual([
        0, 20, 0,
      ]);
      expect(series(result, null).period_totals.map((p) => p.total)).toEqual([
        30, 0, 0,
      ]);
      expect(
        series(result, 'MDL').category_stats.map((c) => [
          c.category_id,
          c.percentage,
        ]),
      ).toEqual([
        ['c1', 75],
        ['c2', 25],
      ]);
      expect(series(result, 'EUR').category_stats).toEqual([
        {
          category_id: 'c2',
          category_name: 'Home',
          total_amount: 20,
          percentage: 100,
        },
      ]);
      expect(series(result, null).category_stats).toEqual([]);
    });

    it('returns no series when there are no bills', async () => {
      const { service, conn } = makeService();
      conn.execute
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getDashboard(userId, {
        type: 'year',
        year: 2026,
      });

      expect(result.by_currency).toEqual([]);
    });
  });
});
