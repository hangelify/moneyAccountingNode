import { randomUUID } from 'node:crypto';
import { MikroORM, EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Category } from '../../entities/category.entity';
import { Household } from '../../entities/household.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { User } from '../../entities/user.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { MarketService } from '../market/market.service';
import { BillCrudService } from './bill-crud.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { StubProvider } from '../exchange-rate/testing/stub-exchange-rate.provider';
import { BillDuplicatesService } from './bill-duplicates.service';
import { BillConversionService } from './household-conversion';
import { Currency } from '../../types/currency.enum';

jest.setTimeout(30_000);

// updateBill (PUT) with items and new_market against the real PostgreSQL
// schema: lines are replaced like on confirm, the status never changes.
describe('update bill (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  let householdId: string;
  let otherHouseholdId: string;
  const subIds: string[] = [];

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
        }),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    const em = orm.em.fork();

    const user = em.create(User, {
      first_name: 'Update',
      email: `update-${randomUUID()}@example.com`,
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Update',
      currency: Currency.EUR,
      created_by: user,
    } as never);
    const other = em.create(Household, {
      name: 'Update other',
      currency: Currency.EUR,
      created_by: user,
    } as never);
    const category = em.create(Category, {
      name: 'Food',
      household,
    } as never);
    const subs = Array.from({ length: 2 }, (_, i) =>
      em.create(SubCategory, { name: `sub-${i}`, category } as never),
    );
    await em.flush();
    userId = user.id;
    householdId = household.id;
    otherHouseholdId = other.id;
    subIds.push(...subs.map((s) => s.id));
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = orm.em.fork().getConnection();
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
    const rates = new ExchangeRateService(fork, new StubProvider());
    return new BillCrudService(
      fork.getRepository(Bill),
      fork.getRepository(Market),
      fork.getRepository(SubCategory),
      fork,
      rates,
      new BillConversionService(fork, rates),
      new BillDuplicatesService(fork),
      new MarketService(fork.getRepository(Market), fork),
    );
  }

  /** A bill in `status` with one read line; returns the bill and line ids. */
  async function makeBill(
    status: BillStatus,
    hid: string = householdId,
  ): Promise<{ id: string; lineId: string }> {
    const fork = orm.em.fork();
    const bill = fork.create(Bill, {
      household: hid,
      created_by: userId,
      status,
      bill_date: '2026-05-19',
      amount: 10,
    } as never);
    const line = fork.create(BillSubCategory, {
      bill,
      raw_name: 'LAPTE 1L',
      product_count: 2,
      amount: 10,
      unit: 'l',
      price_per_unit: 5,
      category_confidence: 0.9,
      category_reasoning: 'Looks like milk.',
      sub_category: subIds[0],
    } as never);
    await fork.flush();
    return { id: bill.id, lineId: line.id };
  }

  async function load(id: string) {
    const fork = orm.em.fork();
    const bill = await fork.findOneOrFail(Bill, id, { populate: ['market'] });
    const items = await fork.find(BillSubCategory, { bill: id });
    return { bill, items };
  }

  it('replaces the items: updates by id, adds new lines, removes the rest', async () => {
    const { id, lineId } = await makeBill(BillStatus.CONFIRMED);

    const result = await crud().updateBill(id, householdId, {
      items: [
        {
          id: lineId,
          sub_category_id: subIds[0],
          product_count: 2,
          amount: 10,
        },
        { sub_category_id: subIds[1], product_count: 1, amount: 3 },
      ],
    });

    const { items } = await load(id);
    expect(items).toHaveLength(2);
    const kept = items.find((i) => i.id === lineId)!;
    expect(kept).toMatchObject({ raw_name: 'LAPTE 1L', unit: 'l' });
    expect(Number(kept.category_confidence)).toBeCloseTo(0.9);
    const added = items.find((i) => i.id !== lineId)!;
    expect(added).toMatchObject({ raw_name: 'sub-1', product_count: 1 });
    expect(result.items).toHaveLength(2);
  });

  it('removes lines left out of items', async () => {
    const { id } = await makeBill(BillStatus.CONFIRMED);

    await crud().updateBill(id, householdId, {
      items: [{ sub_category_id: subIds[1], product_count: 1, amount: 4 }],
    });

    const { items } = await load(id);
    expect(items).toHaveLength(1);
    expect(items[0].raw_name).toBe('sub-1');
  });

  it('keeps the items when items is omitted', async () => {
    const { id, lineId } = await makeBill(BillStatus.CONFIRMED);

    const result = await crud().updateBill(id, householdId, {
      description: 'edited',
    });

    const { items } = await load(id);
    expect(items.map((i) => i.id)).toEqual([lineId]);
    expect(result.items).toHaveLength(1);
    expect(result.description).toBe('edited');
  });

  it('updates every top-level field together with the items', async () => {
    const { id, lineId } = await makeBill(BillStatus.CONFIRMED);

    const result = await crud().updateBill(id, householdId, {
      bill_date: '2026-06-01',
      total_amount: 12.5,
      currency: Currency.EUR,
      description: 'weekly shop',
      fiscal_register_id: 'J1',
      fiscal_receipt_number: '7',
      purchase_time: '09:30',
      items: [
        {
          id: lineId,
          sub_category_id: subIds[1],
          product_count: 1,
          amount: 12.5,
        },
      ],
    });

    expect(result).toMatchObject({
      bill_date: '2026-06-01',
      description: 'weekly shop',
      fiscal_register_id: 'J1',
      fiscal_receipt_number: '7',
      purchase_time: '09:30',
    });
    const { items } = await load(id);
    // The model's confidence was about the old sub-category.
    expect(items[0].category_confidence).toBeNull();
    expect(items[0].price_per_unit).toBeNull();
  });

  it('finds or creates the market named by new_market', async () => {
    const { id } = await makeBill(BillStatus.CONFIRMED);

    const result = await crud().updateBill(id, householdId, {
      new_market: { name: `Lidl ${randomUUID()}`, city: 'Bucharest' },
    });

    const { bill } = await load(id);
    expect(bill.market?.city).toBe('Bucharest');
    expect(result.market?.id).toBe(bill.market!.id);
  });

  it('unlinks the market when market_id is null', async () => {
    const { id } = await makeBill(BillStatus.CONFIRMED);
    const linked = await crud().updateBill(id, householdId, {
      new_market: { name: `Lidl ${randomUUID()}` },
    });
    expect(linked.market).toBeDefined();

    const result = await crud().updateBill(id, householdId, {
      market_id: null,
    });

    const { bill } = await load(id);
    expect(bill.market).toBeNull();
    expect(result.market).toBeUndefined();
  });

  it('keeps the market when market_id is omitted', async () => {
    const { id } = await makeBill(BillStatus.CONFIRMED);
    const linked = await crud().updateBill(id, householdId, {
      new_market: { name: `Lidl ${randomUUID()}` },
    });

    await crud().updateBill(id, householdId, { description: 'edited' });

    const { bill } = await load(id);
    expect(bill.market?.id).toBe(linked.market!.id);
  });

  it('rejects market_id null together with new_market', async () => {
    const { id } = await makeBill(BillStatus.CONFIRMED);

    await expect(
      crud().updateBill(id, householdId, {
        market_id: null,
        new_market: { name: 'Lidl' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects market_id together with new_market', async () => {
    const { id } = await makeBill(BillStatus.CONFIRMED);

    await expect(
      crud().updateBill(id, householdId, {
        market_id: randomUUID(),
        new_market: { name: 'Lidl' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    [
      'a line of another bill',
      async () => (await makeBill(BillStatus.CONFIRMED)).lineId,
    ],
    ['an unknown line', () => Promise.resolve(randomUUID())],
  ])(
    'rejects %s with 400 and leaves the bill untouched',
    async (_, badLine) => {
      const { id, lineId } = await makeBill(BillStatus.CONFIRMED);
      const other = await badLine();

      await expect(
        crud().updateBill(id, householdId, {
          description: 'nope',
          items: [
            {
              id: lineId,
              sub_category_id: subIds[0],
              product_count: 2,
              amount: 10,
            },
            {
              id: other,
              sub_category_id: subIds[0],
              product_count: 1,
              amount: 1,
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      const { bill, items } = await load(id);
      expect(bill.description ?? null).toBeNull();
      expect(items.map((i) => i.id)).toEqual([lineId]);
    },
  );

  it('rejects the same line id twice', async () => {
    const { id, lineId } = await makeBill(BillStatus.CONFIRMED);

    await expect(
      crud().updateBill(id, householdId, {
        items: [
          { id: lineId, product_count: 1, amount: 1 },
          { id: lineId, product_count: 1, amount: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([BillStatus.DRAFT, BillStatus.CONFIRMED])(
    'keeps a %s bill in its status',
    async (status) => {
      const { id, lineId } = await makeBill(status);

      await crud().updateBill(id, householdId, {
        items: [{ id: lineId, product_count: 3, amount: 10 }],
      });

      const { bill } = await load(id);
      expect(bill.status).toBe(status);
    },
  );
});
