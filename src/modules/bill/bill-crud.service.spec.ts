/* eslint-disable @typescript-eslint/unbound-method */
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { BillCrudService } from './bill-crud.service';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { todayIsoDate } from '../../common/utils/calendar-date';
import { BillStatus } from '../../types/bill-status.enum';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { CreateBillDto } from './dto/create-bill.dto';
import { ConfirmBillDto } from './dto/confirm-bill.dto';
import { ParsedBillResponseDto } from './dto/parsed-bill-response.dto';
import { Currency } from '../../types/currency.enum';

function makeRow(
  overrides: Partial<{
    id: string;
    bill_date: string;
    currency: string | null;
    amount: string;
    description: string | null;
    market_id: string | null;
    market_name: string | null;
    market_city: string | null;
    created_at: string;
  }> = {},
) {
  return {
    id: 'bill-1',
    bill_date: '2026-05-19',
    currency: 'EUR',
    amount: '52.30',
    description: null,
    market_id: 'market-1',
    market_name: 'Lidl',
    market_city: 'Bucharest',
    created_at: '2026-05-19T10:00:00.000Z',
    ...overrides,
  };
}

function makeService() {
  const billRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
  } as unknown as EntityRepository<Bill>;
  const marketRepo = {
    findOne: jest.fn(),
  } as unknown as EntityRepository<Market>;
  const subCategoryRepo = {
    find: jest.fn(),
  } as unknown as EntityRepository<SubCategory>;
  const mockExecute = jest.fn();
  const em = {
    persist: jest.fn().mockReturnThis(),
    flush: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    remove: jest.fn().mockReturnThis(),
    getReference: jest.fn().mockReturnValue({}),
    getConnection: jest.fn().mockReturnValue({ execute: mockExecute }),
  } as unknown as EntityManager;
  (em as unknown as { transactional: jest.Mock }).transactional = jest.fn(
    (cb: (em: EntityManager) => unknown) => cb(em),
  );
  return {
    service: new BillCrudService(billRepo, marketRepo, subCategoryRepo, em),
    billRepo,
    marketRepo,
    subCategoryRepo,
    em,
    mockExecute,
  };
}

const userId = 'user-1';
const householdId = 'household-1';
const billId = 'bill-1';
const marketId = 'market-1';
const subCatId = 'subcat-1';

describe('BillCrudService', () => {
  describe('createBill', () => {
    it('creates a bill with items and returns the detail DTO', async () => {
      const { service, marketRepo, subCategoryRepo, em } = makeService();
      (marketRepo.findOne as jest.Mock).mockResolvedValue({
        id: marketId,
        name: 'Lidl',
        city: 'Bucharest',
        user: { id: userId },
        deleted_at: null,
      });
      (subCategoryRepo.find as jest.Mock).mockResolvedValue([
        {
          id: subCatId,
          name: 'bun',
          deleted_at: null,
          category: { name: 'Bread' },
        },
      ]);

      const dto: CreateBillDto = {
        market_id: marketId,
        bill_date: '2026-05-19',
        currency: Currency.EUR,
        total_amount: 9.99,
        items: [{ sub_category_id: subCatId, product_count: 1, amount: 9.99 }],
      };

      const result = await service.createBill(householdId, userId, dto);
      expect(result.total_amount).toBe(9.99);
      expect(em.flush as jest.Mock).toHaveBeenCalled();
    });

    it('throws BadRequestException when market not found for user', async () => {
      const { service, marketRepo } = makeService();
      (marketRepo.findOne as jest.Mock).mockResolvedValue(null);

      const dto: CreateBillDto = {
        market_id: marketId,
        bill_date: '2026-05-19',
        total_amount: 9.99,
        items: [],
      };

      await expect(
        service.createBill(householdId, userId, dto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listBills', () => {
    it('returns all confirmed bills when no filters are given', async () => {
      const { service, mockExecute } = makeService();
      const row = makeRow();
      mockExecute
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([row]);

      const result = await service.listBills(householdId, {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('bill-1');
      expect(result.data[0].total_amount).toBe(52.3);
      expect(result.data[0].market?.name).toBe('Lidl');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const countSql: string = mockExecute.mock.calls[0][0] as string;
      expect(countSql).toContain('b.household_id = ?');
      expect(countSql).toContain("b.status     = 'confirmed'");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const dataSql: string = mockExecute.mock.calls[1][0] as string;
      expect(dataSql).toContain('ORDER  BY b.bill_date DESC');
    });

    it('returns bills sorted bill_date DESC (most recent first)', async () => {
      const { service, mockExecute } = makeService();
      const older = makeRow({ id: 'bill-old', bill_date: '2026-01-01' });
      const newer = makeRow({ id: 'bill-new', bill_date: '2026-06-01' });
      mockExecute
        .mockResolvedValueOnce([{ count: '2' }])
        .mockResolvedValueOnce([newer, older]);

      const result = await service.listBills(householdId, {});

      expect(result.data[0].id).toBe('bill-new');
      expect(result.data[1].id).toBe('bill-old');
    });

    it('appends date_from condition when provided', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        date_from: '2026-03-01',
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('b.bill_date >= ?');
      expect(params).toContain('2026-03-01');
    });

    it('appends date_to condition when provided', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        date_to: '2026-03-31',
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('b.bill_date <= ?');
      expect(params).toContain('2026-03-31');
    });

    it('appends both date conditions when both are provided', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        date_from: '2026-03-01',
        date_to: '2026-03-31',
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('b.bill_date >= ?');
      expect(sql).toContain('b.bill_date <= ?');
      expect(params).toContain('2026-03-01');
      expect(params).toContain('2026-03-31');
    });

    it('appends market_names condition (single value)', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        market_names: ['Lidl'],
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('m.name = ANY(?)');
      expect(params).toContainEqual(['Lidl']);
    });

    it('appends market_names condition (multiple values)', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        market_names: ['Lidl', 'Kaufland'],
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('m.name = ANY(?)');
      expect(params).toContainEqual(['Lidl', 'Kaufland']);
    });

    it('appends currency condition when provided', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        currency: Currency.EUR,
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('b.currency = ?');
      expect(params).toContain('EUR');
    });

    it('appends gt condition for amount_range=gt_100', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        amount_range: ['gt_100'],
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('b.amount > ?');
      expect(params).toContain(100);
    });

    it('appends lt condition for amount_range=lt_500', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        amount_range: ['lt_500'],
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('b.amount < ?');
      expect(params).toContain(500);
    });

    it('appends both gt and lt conditions for a range', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        amount_range: ['gt_100', 'lt_500'],
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('b.amount > ?');
      expect(sql).toContain('b.amount < ?');
      expect(params).toContain(100);
      expect(params).toContain(500);
    });

    it('combines two filters with AND semantics', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        currency: Currency.EUR,
        amount_range: ['gt_100'],
      });

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('b.currency = ?');
      expect(sql).toContain('b.amount > ?');
      expect(params).toContain('EUR');
      expect(params).toContain(100);
    });

    it('maps rows with no market to undefined market on response', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '1' }])
        .mockResolvedValueOnce([
          makeRow({ market_id: null, market_name: null, market_city: null }),
        ]);

      const result = await service.listBills(householdId, {});

      expect(result.data[0].market).toBeUndefined();
    });

    it('throws BadRequestException when date_from is after date_to', async () => {
      const { service } = makeService();

      await expect(
        service.listBills(householdId, {
          date_from: '2026-12-31',
          date_to: '2026-01-01',
        }),
      ).rejects.toThrow('date_from must not be later than date_to');
    });

    // --- pagination ---

    it('returns data array and meta object', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '5' }])
        .mockResolvedValueOnce([makeRow()]);

      const result = await service.listBills(householdId, {});

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('meta');
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(5);
    });

    it('defaults to page=1 and limit=20', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {});

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const dataSql: string = mockExecute.mock.calls[1][0] as string;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const dataParams = mockExecute.mock.calls[1][1] as unknown[];
      expect(dataSql).toContain('LIMIT  ?');
      expect(dataSql).toContain('OFFSET ?');
      expect(dataParams).toContain(20); // limit
      expect(dataParams).toContain(0); // offset = (1-1)*20
    });

    it('applies custom page and limit', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '100' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        page: 3,
        limit: 10,
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const dataParams = mockExecute.mock.calls[1][1] as unknown[];
      expect(dataParams).toContain(10); // limit
      expect(dataParams).toContain(20); // offset = (3-1)*10
    });

    it('computes total_pages correctly', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '25' }])
        .mockResolvedValueOnce([]);

      const result = await service.listBills(householdId, {
        limit: 10,
      });

      expect(result.meta.total_pages).toBe(3); // ceil(25/10)
    });

    it('returns page and limit in meta', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '50' }])
        .mockResolvedValueOnce([]);

      const result = await service.listBills(householdId, {
        page: 2,
        limit: 15,
      });

      expect(result.meta.page).toBe(2);
      expect(result.meta.limit).toBe(15);
    });

    it('COUNT query shares same WHERE conditions as data query', async () => {
      const { service, mockExecute } = makeService();
      mockExecute
        .mockResolvedValueOnce([{ count: '0' }])
        .mockResolvedValueOnce([]);

      await service.listBills(householdId, {
        currency: Currency.EUR,
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const countSql: string = mockExecute.mock.calls[0][0] as string;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const countParams = mockExecute.mock.calls[0][1] as unknown[];
      expect(countSql).toContain('COUNT(*)');
      expect(countParams).toContain('EUR');
    });
  });

  describe('getBill', () => {
    it('throws NotFoundException when bill not found', async () => {
      const { service, billRepo } = makeService();
      (billRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.getBill(billId, householdId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('softDeleteBill', () => {
    it('sets deleted_at on the bill', async () => {
      const { service, billRepo, em } = makeService();
      const bill = { id: billId, deleted_at: undefined } as unknown as Bill;
      (billRepo.findOne as jest.Mock).mockResolvedValue(bill);

      await service.softDeleteBill(billId, householdId);

      expect(bill.deleted_at).toBeInstanceOf(Date);
      expect(em.flush as jest.Mock).toHaveBeenCalled();
    });
  });

  describe('createDraftFromParsed', () => {
    it('saves a draft bill and returns its id', async () => {
      const { service, em } = makeService();

      // Simulate MikroORM populating bill.id after the INSERT (gen_random_uuid())
      let persistedBill: Bill | undefined;
      (em.persist as jest.Mock).mockImplementation((entity: unknown) => {
        if (entity instanceof Bill) persistedBill = entity;
        return em;
      });
      (em.flush as jest.Mock).mockImplementation(() => {
        if (persistedBill) persistedBill.id = 'generated-uuid';
        return Promise.resolve();
      });

      const parsed: ParsedBillResponseDto = {
        draft_id: '',
        market_name: 'Lidl',
        bill_date: '2026-05-19',
        currency: 'EUR',
        total_amount: 9.99,
        items: [],
      };

      const draftId = await service.createDraftFromParsed(
        householdId,
        userId,
        parsed,
      );

      expect(draftId).toEqual({ id: 'generated-uuid', duplicate: false });
      expect(em.flush as jest.Mock).toHaveBeenCalled();
    });
  });

  describe('confirmBill', () => {
    it('confirms a draft bill and returns detail DTO', async () => {
      const { service, subCategoryRepo, em } = makeService();
      const bill = {
        id: billId,
        status: BillStatus.DRAFT,
        amount: 9.99,
        bill_date: '2026-05-19',
        created_at: new Date(),
        deleted_at: undefined,
        market: undefined,
      } as unknown as Bill;
      (em.findOne as jest.Mock).mockResolvedValue(bill);
      (subCategoryRepo.find as jest.Mock).mockResolvedValue([
        {
          id: subCatId,
          name: 'bun',
          deleted_at: null,
          category: { name: 'Bread' },
        },
      ]);

      const dto: ConfirmBillDto = {
        bill_date: '2026-05-19',
        total_amount: 12,
        items: [{ sub_category_id: subCatId, product_count: 1, amount: 12 }],
      };

      const result = await service.confirmBill(
        billId,
        householdId,
        userId,
        dto,
      );

      expect(bill.status).toBe(BillStatus.CONFIRMED);
      expect(result.total_amount).toBe(12);
      expect(em.flush as jest.Mock).toHaveBeenCalled();
    });

    it('throws NotFoundException when draft not found', async () => {
      const { service, subCategoryRepo, em } = makeService();
      (subCategoryRepo.find as jest.Mock).mockResolvedValue([]);
      (em.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        service.confirmBill(billId, householdId, userId, {
          bill_date: '2026-05-19',
          total_amount: 1,
          items: [],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ConflictException when the bill is already confirmed', async () => {
      const { service, subCategoryRepo, em } = makeService();
      (subCategoryRepo.find as jest.Mock).mockResolvedValue([]);
      (em.findOne as jest.Mock).mockResolvedValue({
        id: billId,
        status: BillStatus.CONFIRMED,
      });

      await expect(
        service.confirmBill(billId, householdId, userId, {
          bill_date: '2026-05-19',
          total_amount: 1,
          items: [],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(em.remove as jest.Mock).not.toHaveBeenCalled();
    });
  });

  describe('createDraftFromParsed', () => {
    it('persists items with null sub_category using raw_name and other fields', async () => {
      const { service, em } = makeService();
      const parsed: ParsedBillResponseDto = {
        draft_id: '',
        market_name: null,
        bill_date: null,
        currency: null,
        total_amount: 28.2,
        items: [
          {
            name: 'Paine Pumpern',
            quantity: 1,
            unit: 'piece',
            weight_kg: null,
            price_per_kg: null,
            final_price: 28.2,
            sub_category: null,
            category_confidence: 0.34,
            category_reasoning: undefined,
          },
        ],
      };

      await service.createDraftFromParsed(householdId, userId, parsed);

      const calls = (em.persist as jest.Mock).mock.calls as [unknown][];
      // bill + 1 BillSubCategory for the uncategorized item
      expect(calls).toHaveLength(2);
      const bsc = calls[1][0] as BillSubCategory;
      expect(bsc.raw_name).toBe('Paine Pumpern');
      expect(bsc.unit).toBe('piece');
      expect(bsc.sub_category).toBeUndefined();
      expect(bsc.category_confidence).toBeCloseTo(0.34);
      expect(bsc.amount).toBeCloseTo(28.2);
    });

    it('sets all new fields for categorized items', async () => {
      const { service, em } = makeService();
      const parsed: ParsedBillResponseDto = {
        draft_id: '',
        market_name: null,
        bill_date: null,
        currency: null,
        total_amount: 88.39,
        items: [
          {
            name: 'Carnaciori Ki',
            quantity: null,
            unit: 'kg',
            weight_kg: 0.539,
            price_per_kg: 164.3,
            final_price: 88.39,
            sub_category: {
              id: 'scat-1',
              name: 'sausages',
              category_name: 'Meat & Fish',
            },
            category_confidence: 0.95,
            category_reasoning: '"Carnaciori" are sausages.',
          },
        ],
      };

      await service.createDraftFromParsed(householdId, userId, parsed);

      const calls = (em.persist as jest.Mock).mock.calls as [unknown][];
      expect(calls).toHaveLength(2);
      const bsc = calls[1][0] as BillSubCategory;
      expect(bsc.raw_name).toBe('Carnaciori Ki');
      expect(bsc.unit).toBe('kg');
      expect(bsc.price_per_unit).toBeCloseTo(164.3);
      expect(bsc.category_confidence).toBeCloseTo(0.95);
      expect(bsc.category_reasoning).toBe('"Carnaciori" are sausages.');
      expect(bsc.product_weight).toBeCloseTo(0.539);
    });

    it('keeps items of one sub_category as separate rows with their own names', async () => {
      const { service, em } = makeService();
      const line = (name: string, final_price: number) => ({
        name,
        quantity: 1,
        unit: 'piece' as const,
        weight_kg: null,
        price_per_kg: null,
        final_price,
        sub_category: { id: 'milk-id', name: 'milk', category_name: 'Dairy' },
        category_confidence: 0.96,
        category_reasoning: 'milk',
      });
      const parsed: ParsedBillResponseDto = {
        draft_id: '',
        market_name: null,
        bill_date: null,
        currency: null,
        total_amount: 60,
        items: [line('Lapte 1L', 27.5), line('Lapte 0.5L', 32.5)],
      };

      await service.createDraftFromParsed(householdId, userId, parsed);

      const calls = (em.persist as jest.Mock).mock.calls as [unknown][];
      expect(calls).toHaveLength(3); // bill + 2 BillSubCategory
      const rows = calls.slice(1).map((c) => c[0] as BillSubCategory);
      expect(rows.map((r) => [r.raw_name, r.amount])).toEqual([
        ['Lapte 1L', 27.5],
        ['Lapte 0.5L', 32.5],
      ]);
    });

    it('handles a mix of categorized and uncategorized items producing separate rows', async () => {
      const { service, em } = makeService();
      const parsed: ParsedBillResponseDto = {
        draft_id: '',
        market_name: null,
        bill_date: null,
        currency: null,
        total_amount: 100,
        items: [
          {
            name: 'Lapte 1L',
            quantity: 1,
            unit: 'piece',
            weight_kg: null,
            price_per_kg: null,
            final_price: 27.5,
            sub_category: {
              id: 'milk-id',
              name: 'milk',
              category_name: 'Dairy',
            },
            category_confidence: 0.96,
            category_reasoning: 'milk',
          },
          {
            name: 'Unknown item',
            quantity: 1,
            unit: null,
            weight_kg: null,
            price_per_kg: null,
            final_price: 72.5,
            sub_category: null,
            category_confidence: 0.1,
            category_reasoning: undefined,
          },
        ],
      };

      await service.createDraftFromParsed(householdId, userId, parsed);

      const calls = (em.persist as jest.Mock).mock.calls as [unknown][];
      // bill + 1 categorized BSC + 1 uncategorized BSC = 3 persist calls
      expect(calls).toHaveLength(3);
      const bsc1 = calls[1][0] as BillSubCategory;
      const bsc2 = calls[2][0] as BillSubCategory;
      expect(bsc1.raw_name).toBe('Lapte 1L');
      expect(bsc1.sub_category).toBeDefined();
      expect(bsc2.raw_name).toBe('Unknown item');
      expect(bsc2.sub_category).toBeUndefined();
    });

    // The DTO normally comes out of the zod schema; these guard the DB
    // columns if it does not.
    describe('coerces values the columns cannot hold', () => {
      const item: ParsedBillResponseDto['items'][number] = {
        name: 'BREAD',
        quantity: 1,
        unit: 'piece',
        weight_kg: null,
        price_per_kg: null,
        final_price: 1.2,
        sub_category: null,
        category_confidence: 0.5,
      };
      const base: ParsedBillResponseDto = {
        draft_id: '',
        market_name: null,
        bill_date: '2026-05-07',
        currency: 'EUR',
        total_amount: 1.2,
        items: [item],
      };

      async function draft(parsed: ParsedBillResponseDto) {
        const { service, em } = makeService();
        await service.createDraftFromParsed(householdId, userId, parsed);
        const calls = (em.persist as jest.Mock).mock.calls as [unknown][];
        return {
          bill: calls[0][0] as Bill,
          bsc: calls[1]?.[0] as BillSubCategory | undefined,
        };
      }

      it.each([
        ['EUR', Currency.EUR],
        ['eur', Currency.EUR],
        ['LEI', undefined],
        ['AUD', undefined],
      ])('currency %p -> %p', async (raw, expected) => {
        const { bill } = await draft({ ...base, currency: raw });
        expect(bill.currency).toBe(expected);
      });

      it('keeps a valid ISO bill_date', async () => {
        const { bill } = await draft(base);
        expect(bill.bill_date).toBe('2026-05-07');
        expect(bill.bill_date_inferred).toBe(false);
      });

      it.each(['07.05.2026', '2026-02-30', '0000-01-01', 'garbage'])(
        'replaces bill_date %p with today flagged as inferred',
        async (raw) => {
          const { bill } = await draft({ ...base, bill_date: raw });
          expect(bill.bill_date).toBe(todayIsoDate());
          expect(bill.bill_date_inferred).toBe(true);
        },
      );

      it('falls back to 0 for an out-of-range total', async () => {
        const { bill } = await draft({ ...base, total_amount: 1e20 });
        expect(bill.amount).toBe(0);
      });

      it('truncates raw_name to 255 chars', async () => {
        const { bsc } = await draft({
          ...base,
          items: [{ ...item, name: 'x'.repeat(300) }],
        });
        expect(bsc?.raw_name).toHaveLength(255);
      });

      it('drops out-of-range item numbers and unknown units', async () => {
        const { bsc } = await draft({
          ...base,
          items: [
            {
              ...item,
              quantity: 1e12,
              unit: 'kilograms' as never,
              weight_kg: 1e8,
              price_per_kg: 1e9,
              final_price: Infinity,
              category_confidence: 1.7,
            },
          ],
        });
        expect(bsc).toMatchObject({ product_count: 1, amount: 0 });
        expect(bsc?.unit).toBeUndefined();
        expect(bsc?.product_weight).toBeUndefined();
        expect(bsc?.price_per_unit).toBeUndefined();
        expect(bsc?.category_confidence).toBeUndefined();
      });

      it('drops a negative category confidence', async () => {
        const { bsc } = await draft({
          ...base,
          items: [{ ...item, category_confidence: -0.5 }],
        });
        expect(bsc?.category_confidence).toBeUndefined();
      });
    });
  });
});
