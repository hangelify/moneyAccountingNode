import { randomUUID } from 'node:crypto';
import { MikroORM, EntityManager, SimpleLogger } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Category } from '../../entities/category.entity';
import { Household } from '../../entities/household.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { User } from '../../entities/user.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { BillCrudService } from './bill-crud.service';
import type { CreateBillItemDto } from './dto/create-bill.dto';
import type { ConfirmBillItemDto } from './dto/confirm-bill.dto';

jest.setTimeout(30_000);

// confirmBill / createBill against the real PostgreSQL schema: a rejected
// request leaves the draft as it was, and two confirms do not interleave.
describe('confirm and create bill (PostgreSQL)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  const queries: string[] = [];
  let userId: string;
  let confirmerId: string;
  let householdId: string;
  let otherHouseholdId: string;
  const subIds: string[] = [];
  let foreignSubId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: PostgreSqlDriver,
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432', 10),
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
          dbName: process.env.DB_NAME || 'accounting',
          entities: ['./dist/**/*.entity.js'],
          entitiesTs: ['./src/**/*.entity.ts'],
          allowGlobalContext: true,
          debug: ['query'],
          loggerFactory: (options) =>
            new SimpleLogger({
              ...options,
              writer: (message) => queries.push(message),
            }),
        }),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    em = orm.em.fork();

    const user = em.create(User, {
      first_name: 'Confirm',
      email: `p08-confirm-${randomUUID()}@example.com`,
      password: 'x',
    } as never);
    const confirmer = em.create(User, {
      first_name: 'Confirmer',
      email: `p36-confirmer-${randomUUID()}@example.com`,
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'P08 confirm',
      created_by: user,
    } as never);
    const other = em.create(Household, {
      name: 'P08 other',
      created_by: user,
    } as never);
    const category = em.create(Category, {
      name: 'Food',
      household,
    } as never);
    const foreignCategory = em.create(Category, {
      name: 'Food',
      household: other,
    } as never);
    const subs = Array.from({ length: 5 }, (_, i) =>
      em.create(SubCategory, { name: `sub-${i}`, category } as never),
    );
    const foreign = em.create(SubCategory, {
      name: 'foreign',
      category: foreignCategory,
    } as never);
    await em.flush();
    userId = user.id;
    confirmerId = confirmer.id;
    householdId = household.id;
    otherHouseholdId = other.id;
    subIds.push(...subs.map((s) => s.id));
    foreignSubId = foreign.id;
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = em.getConnection();
    const hids = [householdId, otherHouseholdId];
    await conn.execute(
      'DELETE FROM bill_sub_categories WHERE bill_id IN (SELECT id FROM bills WHERE household_id IN (?, ?))',
      hids,
    );
    await conn.execute('DELETE FROM bills WHERE household_id IN (?, ?)', hids);
    await conn.execute(
      'DELETE FROM markets WHERE household_id IN (?, ?)',
      hids,
    );
    await conn.execute(
      'DELETE FROM sub_categories WHERE category_id IN (SELECT id FROM categories WHERE household_id IN (?, ?))',
      hids,
    );
    await conn.execute(
      'DELETE FROM categories WHERE household_id IN (?, ?)',
      hids,
    );
    await conn.execute('DELETE FROM households WHERE id IN (?, ?)', hids);
    await conn.execute('DELETE FROM users WHERE id IN (?, ?)', [
      userId,
      confirmerId,
    ]);
    await orm.close(true);
  });

  function crud(fork: EntityManager = orm.em.fork()) {
    return new BillCrudService(
      fork.getRepository(Bill),
      fork.getRepository(Market),
      fork.getRepository(SubCategory),
      fork,
    );
  }

  async function makeDraft(subId?: string): Promise<string> {
    const fork = orm.em.fork();
    const bill = fork.create(Bill, {
      household: householdId,
      created_by: userId,
      status: BillStatus.DRAFT,
      bill_date: '2026-05-19',
      amount: 10,
    } as never);
    fork.create(BillSubCategory, {
      bill,
      raw_name: 'LAPTE 1L',
      product_count: 2,
      amount: 10,
      unit: 'l',
      price_per_unit: 5,
      category_confidence: 0.9,
      category_reasoning: 'Looks like milk.',
      sub_category: subId,
    } as never);
    await fork.flush();
    return bill.id;
  }

  /** A draft with one recognized line; returns the bill and line ids. */
  async function makeDraftLine(subId?: string) {
    const id = await makeDraft(subId);
    const { items: lines } = await load(id);
    return { id, lineId: lines[0].id };
  }

  async function load(id: string) {
    const fork = orm.em.fork();
    const bill = await fork.findOneOrFail(Bill, id);
    const items = await fork.find(BillSubCategory, { bill: id });
    return { bill, items };
  }

  const required = { bill_date: '2026-05-20', total_amount: 1 };

  function items(...ids: string[]): CreateBillItemDto[] {
    return ids.map((id) => ({
      sub_category_id: id,
      product_count: 1,
      amount: 1,
    }));
  }

  describe('confirmBill', () => {
    it.each([
      ['a sub-category of another household', () => foreignSubId],
      ['a nonexistent sub-category', () => randomUUID()],
    ])(
      'rejects %s with 400 and leaves the draft items untouched',
      async (_, badId) => {
        const id = await makeDraft();

        await expect(
          crud().confirmBill(id, householdId, userId, {
            ...required,
            items: items(subIds[0], badId()),
          }),
        ).rejects.toBeInstanceOf(BadRequestException);

        const { bill, items: left } = await load(id);
        expect(bill.status).toBe(BillStatus.DRAFT);
        expect(left).toHaveLength(1);
        expect(left[0]).toMatchObject({
          raw_name: 'LAPTE 1L',
          unit: 'l',
          product_count: 2,
        });
        expect(Number(left[0].category_confidence)).toBeCloseTo(0.9);
      },
    );

    it('saves two items of the same sub-category as two lines', async () => {
      const id = await makeDraft();

      const result = await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: [
          {
            sub_category_id: subIds[0],
            product_count: 1,
            amount: 5,
            product_weight: 2,
          },
          {
            sub_category_id: subIds[0],
            product_count: 1,
            amount: 3,
            product_weight: 1,
          },
        ],
      });

      const { items: saved } = await load(id);
      expect(saved).toHaveLength(2);
      expect(saved.map((i) => Number(i.product_weight)).sort()).toEqual([1, 2]);
      expect(result.items).toHaveLength(2);
    });

    it('lets one of two concurrent confirms win and answers 409 to the other', async () => {
      const id = await makeDraft();

      const results = await Promise.allSettled([
        crud().confirmBill(id, householdId, userId, {
          ...required,
          items: items(subIds[0], subIds[1]),
        }),
        crud().confirmBill(id, householdId, userId, {
          ...required,
          items: items(subIds[2], subIds[3], subIds[4]),
        }),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0].reason).toBeInstanceOf(ConflictException);

      const { bill, items: saved } = await load(id);
      expect(bill.status).toBe(BillStatus.CONFIRMED);
      const savedIds = saved.map((i) => i.sub_category!.id).sort();
      const wonIds = won[0].value.items.map((i) => i.sub_category!.id).sort();
      expect(savedIds).toEqual(wonIds);
    });

    it('answers 409 when the bill is already confirmed', async () => {
      const id = await makeDraft();
      await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: items(subIds[0]),
      });

      await expect(
        crud().confirmBill(id, householdId, userId, {
          ...required,
          items: items(subIds[1]),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      const { items: saved } = await load(id);
      expect(saved.map((i) => i.sub_category!.id)).toEqual([subIds[0]]);
    });

    it('creates a new market inside the confirm', async () => {
      const id = await makeDraft();

      const result = await crud().confirmBill(id, householdId, userId, {
        ...required,
        new_market: { name: `P08 market ${randomUUID()}` },
        items: items(subIds[0]),
      });

      const { bill } = await load(id);
      expect(bill.market?.id).toBe(result.market?.id);
      expect(result.market?.id).toBeDefined();
    });

    it('runs the same number of SQL queries for 1 and 5 items', async () => {
      async function count(ids: string[]) {
        const id = await makeDraft();
        queries.length = 0;
        await crud().confirmBill(id, householdId, userId, {
          ...required,
          items: items(...ids),
        });
        return queries.length;
      }

      const one = await count(subIds.slice(0, 1));
      const five = await count(subIds);
      expect(five).toBe(one);
    });
  });

  describe('confirming draft lines', () => {
    function line(
      lineId: string,
      overrides: Partial<ConfirmBillItemDto> = {},
    ): ConfirmBillItemDto {
      return {
        id: lineId,
        sub_category_id: subIds[0],
        product_count: 2,
        amount: 10,
        ...overrides,
      };
    }

    it('updates the line in place and keeps what the model read', async () => {
      const { id, lineId } = await makeDraftLine(subIds[0]);

      const result = await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: [line(lineId)],
      });

      const { items: saved } = await load(id);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        id: lineId,
        raw_name: 'LAPTE 1L',
        unit: 'l',
        category_reasoning: 'Looks like milk.',
      });
      expect(Number(saved[0].category_confidence)).toBeCloseTo(0.9);
      expect(Number(saved[0].price_per_unit)).toBe(5);
      expect(result.items[0]).toMatchObject({
        id: lineId,
        raw_name: 'LAPTE 1L',
        category_confidence: 0.9,
      });
    });

    it('saves an edited raw_name', async () => {
      const { id, lineId } = await makeDraftLine(subIds[0]);

      await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: [line(lineId, { raw_name: 'Milk 1L' })],
      });

      const { items: saved } = await load(id);
      expect(saved[0].raw_name).toBe('Milk 1L');
    });

    it('confirms a line without a sub-category', async () => {
      const { id, lineId } = await makeDraftLine();

      const result = await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: [line(lineId, { sub_category_id: undefined })],
      });

      const { bill, items: saved } = await load(id);
      expect(bill.status).toBe(BillStatus.CONFIRMED);
      expect(saved[0].sub_category).toBeNull();
      expect(saved[0].raw_name).toBe('LAPTE 1L');
      expect(result.items[0].sub_category).toBeNull();
    });

    it('saves a new uncategorized line under its raw_name', async () => {
      const id = await makeDraft();

      await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: [{ raw_name: 'Bag', product_count: 1, amount: 1 }],
      });

      const { items: saved } = await load(id);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ raw_name: 'Bag', sub_category: null });
    });

    it('clears the model confidence and reasoning when the sub-category changes', async () => {
      const { id, lineId } = await makeDraftLine(subIds[0]);

      await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: [line(lineId, { sub_category_id: subIds[1] })],
      });

      const { items: saved } = await load(id);
      expect(saved[0].sub_category?.id).toBe(subIds[1]);
      expect(saved[0].category_confidence).toBeNull();
      expect(saved[0].category_reasoning).toBeNull();
      expect(saved[0].unit).toBe('l');
    });

    it.each([
      ['the count of an unweighed line', { product_count: 3 }],
      ['the weight', { product_weight: 1.5 }],
    ])('clears price_per_unit when %s changes', async (_, change) => {
      const { id, lineId } = await makeDraftLine(subIds[0]);

      await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: [line(lineId, change)],
      });

      const { items: saved } = await load(id);
      expect(saved[0].price_per_unit).toBeNull();
    });

    it('clears price_per_unit when the amount changes', async () => {
      const { id, lineId } = await makeDraftLine(subIds[0]);

      await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: [line(lineId, { amount: 12 })],
      });

      const { items: saved } = await load(id);
      expect(saved[0].price_per_unit).toBeNull();
    });

    it('deletes draft lines left out of the confirm', async () => {
      const { id } = await makeDraftLine(subIds[0]);

      await crud().confirmBill(id, householdId, userId, {
        ...required,
        items: items(subIds[1]),
      });

      const { items: saved } = await load(id);
      expect(saved.map((i) => i.sub_category?.id)).toEqual([subIds[1]]);
    });

    it.each([
      ['a line of another bill', async () => (await makeDraftLine()).lineId],
      ['a nonexistent line', () => Promise.resolve(randomUUID())],
    ])('rejects %s with 400 and keeps the draft', async (_, badLineId) => {
      const { id } = await makeDraftLine(subIds[0]);

      await expect(
        crud().confirmBill(id, householdId, userId, {
          ...required,
          items: [line(await badLineId())],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      const { bill, items: left } = await load(id);
      expect(bill.status).toBe(BillStatus.DRAFT);
      expect(left).toHaveLength(1);
    });

    it('rejects a repeated line id with 400', async () => {
      const { id, lineId } = await makeDraftLine(subIds[0]);

      await expect(
        crud().confirmBill(id, householdId, userId, {
          ...required,
          items: [line(lineId), line(lineId)],
        }),
      ).rejects.toThrow(/duplicate/i);
    });
  });

  describe('confirm author', () => {
    it('keeps created_by and records who confirmed and when', async () => {
      const id = await makeDraft();
      const before = new Date();

      await crud().confirmBill(id, householdId, confirmerId, {
        ...required,
        items: items(subIds[0]),
      });

      const { bill } = await load(id);
      expect(bill.created_by?.id).toBe(userId);
      expect(bill.confirmed_by?.id).toBe(confirmerId);
      expect(bill.confirmed_at!.getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
    });

    it('indexes confirmed_by, so deleting a user does not scan bills', async () => {
      const rows = (await em
        .getConnection()
        .execute(
          `SELECT indexdef FROM pg_indexes WHERE tablename = 'bills' AND indexname = 'bills_confirmed_by_user_id_index'`,
        )) as Array<{ indexdef: string }>;
      expect(rows[0]?.indexdef).toMatch(/\(confirmed_by_user_id\)/);
    });

    it('leaves confirmed_by empty on a bill created by hand', async () => {
      const result = await crud().createBill(householdId, userId, {
        ...required,
        items: items(subIds[0]),
      });

      const { bill } = await load(result.id);
      expect(bill.created_by?.id).toBe(userId);
      expect(bill.confirmed_by).toBeNull();
      expect(bill.confirmed_at).toBeNull();
    });
  });

  describe('amount_mismatch', () => {
    function priced(...amounts: number[]): CreateBillItemDto[] {
      return amounts.map((amount, i) => ({
        sub_category_id: subIds[i],
        product_count: 1,
        amount,
      }));
    }

    it('is false when the confirmed items add up to the total', async () => {
      const id = await makeDraft();
      const result = await crud().confirmBill(id, householdId, userId, {
        ...required,
        total_amount: 10.01,
        items: priced(4.5, 5.5),
      });
      expect(result.amount_mismatch).toBe(false);
    });

    it('is true when the confirmed items exceed a discounted total', async () => {
      const id = await makeDraft();
      const result = await crud().confirmBill(id, householdId, userId, {
        ...required,
        total_amount: 9,
        items: priced(4.5, 5.5),
      });
      expect(result.amount_mismatch).toBe(true);
    });

    it('is reported by createBill and getBill', async () => {
      const created = await crud().createBill(householdId, userId, {
        ...required,
        total_amount: 20,
        items: priced(5),
      });
      expect(created.amount_mismatch).toBe(true);
      const read = await crud().getBill(created.id, householdId);
      expect(read.amount_mismatch).toBe(true);
    });

    it('turns true when PUT changes the total away from the items', async () => {
      const created = await crud().createBill(householdId, userId, {
        ...required,
        total_amount: 5,
        items: priced(5),
      });
      expect(created.amount_mismatch).toBe(false);

      const updated = await crud().updateBill(created.id, householdId, {
        total_amount: 7,
      });
      expect(updated.amount_mismatch).toBe(true);
    });

    it('is reported per bill in the list', async () => {
      const date = '1999-01-01';
      const ok = await crud().createBill(householdId, userId, {
        bill_date: date,
        total_amount: 10,
        items: priced(4, 6),
      });
      const off = await crud().createBill(householdId, userId, {
        bill_date: date,
        total_amount: 12,
        items: priced(4, 6),
      });

      const { data } = await crud().listBills(householdId, {
        date_from: date,
        date_to: date,
      });
      const byId = new Map(data.map((b) => [b.id, b.amount_mismatch]));
      expect(byId.get(ok.id)).toBe(false);
      expect(byId.get(off.id)).toBe(true);
    });
  });

  describe('createBill', () => {
    it('saves two items of the same sub-category as two lines', async () => {
      const result = await crud().createBill(householdId, userId, {
        bill_date: '2026-05-19',
        total_amount: 2,
        items: items(subIds[0], subIds[0]),
      });

      const { items: saved } = await load(result.id);
      expect(saved).toHaveLength(2);
    });

    it('runs the same number of SQL queries for 1 and 5 items', async () => {
      async function count(ids: string[]) {
        queries.length = 0;
        await crud().createBill(householdId, userId, {
          bill_date: '2026-05-19',
          total_amount: ids.length,
          items: items(...ids),
        });
        return queries.length;
      }

      const one = await count(subIds.slice(0, 1));
      const five = await count(subIds);
      expect(five).toBe(one);
    });
  });
});
