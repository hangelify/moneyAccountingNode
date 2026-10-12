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

jest.setTimeout(30_000);

// confirmBill / createBill against the real PostgreSQL schema: a rejected
// request leaves the draft as it was, and two confirms do not interleave.
describe('confirm and create bill (PostgreSQL)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  const queries: string[] = [];
  let userId: string;
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
    await conn.execute('DELETE FROM users WHERE id = ?', [userId]);
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

  async function makeDraft(): Promise<string> {
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
    } as never);
    await fork.flush();
    return bill.id;
  }

  async function load(id: string) {
    const fork = orm.em.fork();
    const bill = await fork.findOneOrFail(Bill, id);
    const items = await fork.find(BillSubCategory, { bill: id });
    return { bill, items };
  }

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

    it('rejects duplicate sub_category_id with 400 and keeps the draft', async () => {
      const id = await makeDraft();

      await expect(
        crud().confirmBill(id, householdId, userId, {
          items: items(subIds[0], subIds[0]),
        }),
      ).rejects.toThrow(/duplicate/i);

      const { bill, items: left } = await load(id);
      expect(bill.status).toBe(BillStatus.DRAFT);
      expect(left.map((i) => i.raw_name)).toEqual(['LAPTE 1L']);
    });

    it('lets one of two concurrent confirms win and answers 409 to the other', async () => {
      const id = await makeDraft();

      const results = await Promise.allSettled([
        crud().confirmBill(id, householdId, userId, {
          items: items(subIds[0], subIds[1]),
        }),
        crud().confirmBill(id, householdId, userId, {
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
        items: items(subIds[0]),
      });

      await expect(
        crud().confirmBill(id, householdId, userId, {
          items: items(subIds[1]),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      const { items: saved } = await load(id);
      expect(saved.map((i) => i.sub_category!.id)).toEqual([subIds[0]]);
    });

    it('creates a new market inside the confirm', async () => {
      const id = await makeDraft();

      const result = await crud().confirmBill(id, householdId, userId, {
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
          items: items(...ids),
        });
        return queries.length;
      }

      const one = await count(subIds.slice(0, 1));
      const five = await count(subIds);
      expect(five).toBe(one);
    });
  });

  describe('createBill', () => {
    it('rejects duplicate sub_category_id with 400', async () => {
      await expect(
        crud().createBill(householdId, userId, {
          bill_date: '2026-05-19',
          total_amount: 2,
          items: items(subIds[0], subIds[0]),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
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
