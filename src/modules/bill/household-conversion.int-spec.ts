import { randomUUID } from 'node:crypto';
import { MikroORM, EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Category } from '../../entities/category.entity';
import { Household } from '../../entities/household.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { User } from '../../entities/user.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { Currency } from '../../types/currency.enum';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { EXCHANGE_RATE_PROVIDER } from '../exchange-rate/exchange-rate.provider';
import { StubProvider } from '../exchange-rate/testing/stub-exchange-rate.provider';
import { BillCrudService } from './bill-crud.service';
import {
  BillConversionService,
  fetchUnconverted,
} from './household-conversion';
import type { BillResponseDto } from './dto/bill-response.dto';

jest.setTimeout(30_000);

const SOURCE = 'TEST-HC';

// MDL per unit, as the stub provider answers; 2026-03-09 is never published.
const RATES: Record<string, Record<string, number>> = {
  '2026-03-02': { EUR: 20.0, USD: 18.0 },
  '2026-03-07': { EUR: 25.0, USD: 18.0 },
  // Published only for the bill-write specs, which find it unsaved.
  '2026-03-11': { EUR: 22.0, USD: 18.0 },
};

// Bills read in the household's currency, converted at read time from the
// saved rates of SOURCE.
describe('household currency conversion (PostgreSQL)', () => {
  let orm: MikroORM;
  let provider: StubProvider;
  let crud: BillCrudService;
  let userId: string;
  // EUR household with categories Food and Home.
  let householdId: string;
  // MDL household, for the inverse direction.
  let mdlHouseholdId: string;
  // EUR household that bill writes go to, so they leave the others as seeded.
  let writeHouseholdId: string;
  let writeSubId: string;
  const id = {
    eur0302: '',
    mdl0302: '',
    mdl0307: '',
    mdl0309: '',
    none0302: '',
    mdlHhEur0302: '',
  };

  beforeAll(async () => {
    provider = new StubProvider(SOURCE);
    provider.answer = (date) =>
      Promise.resolve(
        RATES[date]
          ? {
              date,
              rates: Object.entries(RATES[date]).map(([currency, rate]) => ({
                currency,
                rate,
                nominal: 1,
              })),
            }
          : null,
      );

    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          ...createMikroOrmConfig(),
          allowGlobalContext: true,
        }),
        MikroOrmModule.forFeature([Bill, Market, SubCategory]),
        ExchangeRateModule,
      ],
      providers: [BillCrudService, BillConversionService],
    })
      .overrideProvider(EXCHANGE_RATE_PROVIDER)
      .useValue(provider)
      .compile();
    orm = mod.get(MikroORM);
    crud = mod.get(BillCrudService);
    await mod
      .get(ExchangeRateService)
      .ensureDays(['2026-03-02', '2026-03-07'], { max: 10 });

    const em: EntityManager = orm.em.fork();
    const user = em.create(User, {
      first_name: 'Convert',
      email: `household-conversion-${randomUUID()}@example.com`,
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Conversion EUR',
      currency: Currency.EUR,
      created_by: user,
    } as never);
    const mdlHousehold = em.create(Household, {
      name: 'Conversion MDL',
      currency: Currency.MDL,
      created_by: user,
    } as never);
    const writeHousehold = em.create(Household, {
      name: 'Conversion writes',
      currency: Currency.EUR,
      created_by: user,
    } as never);
    const writeFood = em.create(Category, {
      name: 'Food',
      household: writeHousehold,
    } as never);
    const writeBread = em.create(SubCategory, {
      name: 'bread',
      category: writeFood,
    } as never);
    const food = em.create(Category, { name: 'Food', household } as never);
    const home = em.create(Category, { name: 'Home', household } as never);
    const bread = em.create(SubCategory, {
      name: 'bread',
      category: food,
    } as never);
    const soap = em.create(SubCategory, {
      name: 'soap',
      category: home,
    } as never);

    const bill = (
      data: Record<string, unknown>,
      items: Array<[SubCategory, number]>,
    ) => {
      const b = em.create(Bill, {
        household,
        created_by: user,
        status: BillStatus.CONFIRMED,
        ...data,
      } as never);
      for (const [sub, amount] of items) {
        em.create(BillSubCategory, {
          bill: b,
          sub_category: sub,
          raw_name: 'item',
          product_count: 1,
          amount,
        } as never);
      }
      return b;
    };

    const bills = {
      eur0302: bill(
        { bill_date: '2026-03-02', amount: 10, currency: Currency.EUR },
        [[bread, 10]],
      ),
      mdl0302: bill(
        { bill_date: '2026-03-02', amount: 200, currency: Currency.MDL },
        [
          [bread, 120],
          [soap, 80],
        ],
      ),
      // A Saturday: BNM publishes no new rate, the day still has its own.
      mdl0307: bill(
        { bill_date: '2026-03-07', amount: 200, currency: Currency.MDL },
        [[bread, 200]],
      ),
      // No saved day: the latest earlier one (03-07) is used.
      mdl0309: bill(
        { bill_date: '2026-03-09', amount: 100, currency: Currency.MDL },
        [[bread, 100]],
      ),
      none0302: bill({ bill_date: '2026-03-02', amount: 31, currency: null }, [
        [bread, 31],
      ]),
      mdlHhEur0302: bill(
        {
          bill_date: '2026-03-02',
          amount: 10,
          currency: Currency.EUR,
          household: mdlHousehold,
        },
        [],
      ),
    };

    await em.flush();
    userId = user.id;
    householdId = household.id;
    mdlHouseholdId = mdlHousehold.id;
    writeHouseholdId = writeHousehold.id;
    writeSubId = writeBread.id;
    for (const key of Object.keys(id) as Array<keyof typeof id>) {
      id[key] = bills[key].id;
    }
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = orm.em.getConnection();
    const hids = [householdId, mdlHouseholdId, writeHouseholdId];
    await conn.execute(
      'DELETE FROM bill_sub_categories WHERE bill_id IN (SELECT id FROM bills WHERE household_id IN (?, ?, ?))',
      hids,
    );
    await conn.execute(
      'DELETE FROM bills WHERE household_id IN (?, ?, ?)',
      hids,
    );
    await conn.execute(
      'DELETE FROM sub_categories WHERE category_id IN (SELECT id FROM categories WHERE household_id IN (?, ?, ?))',
      hids,
    );
    await conn.execute(
      'DELETE FROM categories WHERE household_id IN (?, ?, ?)',
      hids,
    );
    await conn.execute('DELETE FROM households WHERE id IN (?, ?, ?)', hids);
    await conn.execute('DELETE FROM users WHERE id = ?', [userId]);
    await conn.execute('DELETE FROM exchange_rates WHERE source = ?', [SOURCE]);
    await conn.execute('DELETE FROM exchange_rate_days WHERE source = ?', [
      SOURCE,
    ]);
    await orm.close(true);
  });

  async function listed(hid = householdId): Promise<BillResponseDto[]> {
    const { data } = await crud.listBills(hid, {});
    return data;
  }

  async function listedBill(billId: string, hid = householdId) {
    const bill = (await listed(hid)).find((b) => b.id === billId);
    expect(bill).toBeDefined();
    return bill!;
  }

  describe('bill list', () => {
    it('list: EUR bill has household_amount 10 and factor 1', async () => {
      const bill = await listedBill(id.eur0302);
      expect(bill.household_currency).toBe(Currency.EUR);
      expect(bill.household_amount).toBe(10);
    });

    it('list: MDL 200 on 03-02 → household_amount 10.00', async () => {
      const bill = await listedBill(id.mdl0302);
      expect(bill.household_currency).toBe(Currency.EUR);
      expect(bill.household_amount).toBe(10);
    });

    it("list: MDL 200 on Saturday 03-07 uses that day's rate → 8.00", async () => {
      expect((await listedBill(id.mdl0307)).household_amount).toBe(8);
    });

    it('list: MDL 100 on 03-09 with no saved day uses 03-07 → 4.00', async () => {
      expect((await listedBill(id.mdl0309)).household_amount).toBe(4);
    });

    it('list: NULL-currency bill → household_amount null', async () => {
      const bill = await listedBill(id.none0302);
      expect(bill.household_currency).toBe(Currency.EUR);
      expect(bill.household_amount).toBeNull();
    });

    it('MDL household: EUR 10 on 03-02 → household_amount 200.00', async () => {
      const bill = await listedBill(id.mdlHhEur0302, mdlHouseholdId);
      expect(bill.household_currency).toBe(Currency.MDL);
      expect(bill.household_amount).toBe(200);
    });
  });

  describe('bill detail', () => {
    it('detail: MDL bill on 03-09 → exchange_rate { rate: 0.04, rate_date: 2026-03-07 }', async () => {
      const bill = await crud.getBill(id.mdl0309, householdId);
      expect(bill.household_currency).toBe(Currency.EUR);
      expect(bill.household_amount).toBe(4);
      expect(bill.exchange_rate).toEqual({
        rate: 0.04,
        rate_date: '2026-03-07',
      });
    });

    it('detail: EUR bill → exchange_rate null', async () => {
      const bill = await crud.getBill(id.eur0302, householdId);
      expect(bill.household_amount).toBe(10);
      expect(bill.exchange_rate).toBeNull();
    });

    it('detail: NULL-currency bill → household_amount and exchange_rate null', async () => {
      const bill = await crud.getBill(id.none0302, householdId);
      expect(bill.household_currency).toBe(Currency.EUR);
      expect(bill.household_amount).toBeNull();
      expect(bill.exchange_rate).toBeNull();
    });
  });

  describe('fetchUnconverted', () => {
    const unconverted = (currency?: Currency) =>
      fetchUnconverted(
        orm.em.getConnection(),
        SOURCE,
        householdId,
        '2026-03-01',
        '2026-04-01',
        currency,
      );

    it('reports the bills without a currency in their own amount', async () => {
      expect(await unconverted()).toEqual([
        { currency: null, bill_count: 1, amount: 31 },
      ]);
    });

    it('with a currency, looks only at bills in it', async () => {
      expect(await unconverted(Currency.MDL)).toEqual([]);
    });

    it('lists bills whose rate is not saved, by currency', async () => {
      // A source with no saved rates: no MDL bill can be converted.
      const rows = await fetchUnconverted(
        orm.em.getConnection(),
        'TEST-HC-NONE',
        householdId,
        '2026-03-01',
        '2026-04-01',
      );
      expect(rows).toEqual([
        { currency: Currency.MDL, bill_count: 3, amount: 500 },
        { currency: null, bill_count: 1, amount: 31 },
      ]);
    });
  });

  it('list and detail make zero provider calls', async () => {
    provider.calls = [];

    await crud.listBills(householdId, {});
    await crud.getBill(id.mdl0309, householdId);

    expect(provider.calls).toEqual([]);
  });

  // Writes save the bill's day after they commit, then answer converted.
  describe('bill writes', () => {
    const items = () => [
      { sub_category_id: writeSubId, raw_name: 'item', amount: 100 },
    ];

    async function draft(
      currency: Currency | null,
      billDate: string,
    ): Promise<string> {
      const em = orm.em.fork();
      const d = em.create(Bill, {
        household: em.getReference(Household, writeHouseholdId),
        created_by: em.getReference(User, userId),
        status: BillStatus.DRAFT,
        bill_date: billDate,
        amount: 100,
        currency,
      } as never);
      await em.flush();
      return d.id;
    }

    function confirmDto(billDate: string, currency?: Currency) {
      return {
        bill_date: billDate,
        total_amount: 100,
        currency,
        items: items().map((i) => ({ ...i, product_count: 1 })),
      } as never;
    }

    async function withDownProvider<T>(fn: () => Promise<T>): Promise<T> {
      const original = provider.answer;
      provider.answer = () => Promise.reject(new ServiceUnavailableException());
      try {
        return await fn();
      } finally {
        provider.answer = original;
      }
    }

    it('confirming an MDL draft in an EUR household saves its day', async () => {
      const draftId = await draft(Currency.MDL, '2026-03-11');
      provider.calls = [];

      const res = await crud.confirmBill(
        draftId,
        writeHouseholdId,
        userId,
        confirmDto('2026-03-11'),
      );

      expect(provider.calls).toEqual(['2026-03-11']);
      expect(res.household_currency).toBe(Currency.EUR);
      expect(res.household_amount).toBe(4.55);
    });

    it('confirm succeeds when the provider is down', async () => {
      const draftId = await draft(Currency.MDL, '2026-02-20');

      const res = await withDownProvider(() =>
        crud.confirmBill(
          draftId,
          writeHouseholdId,
          userId,
          confirmDto('2026-02-20'),
        ),
      );

      expect(res.status).toBe(BillStatus.CONFIRMED);
      expect(res.household_amount).toBeNull();
    });

    it('confirming an EUR bill in an EUR household makes no call', async () => {
      const draftId = await draft(Currency.EUR, '2026-03-13');
      provider.calls = [];

      const res = await crud.confirmBill(
        draftId,
        writeHouseholdId,
        userId,
        confirmDto('2026-03-13'),
      );

      expect(provider.calls).toEqual([]);
      expect(res.household_amount).toBe(100);
    });

    it('createBill with MDL saves its day', async () => {
      provider.calls = [];

      const res = await crud.createBill(writeHouseholdId, userId, {
        bill_date: '2026-03-14',
        currency: Currency.MDL,
        total_amount: 100,
        items: items(),
      } as never);

      expect(provider.calls).toEqual(['2026-03-14']);
      expect(res.household_currency).toBe(Currency.EUR);
    });

    it('createBill with MDL on a published day answers the converted amount', async () => {
      const res = await crud.createBill(writeHouseholdId, userId, {
        bill_date: '2026-03-02',
        currency: Currency.MDL,
        total_amount: 200,
        items: items(),
      } as never);

      expect(res.household_amount).toBe(10);
      expect(res.exchange_rate).toEqual({
        rate: 0.05,
        rate_date: '2026-03-02',
      });
    });

    it('PUT changing currency EUR→MDL and date to a new day saves that day and returns the new household_amount', async () => {
      const created = await crud.createBill(writeHouseholdId, userId, {
        bill_date: '2026-03-02',
        currency: Currency.EUR,
        total_amount: 200,
        items: items(),
      } as never);
      expect(created.household_amount).toBe(200);
      provider.calls = [];

      const res = await crud.updateBill(created.id, writeHouseholdId, {
        currency: Currency.MDL,
        bill_date: '2026-03-07',
      });

      // 03-07 is already saved by the fixture, so the day needs no call.
      expect(provider.calls).toEqual([]);
      expect(res.household_currency).toBe(Currency.EUR);
      expect(res.household_amount).toBe(8);

      const moved = await crud.updateBill(created.id, writeHouseholdId, {
        bill_date: '2026-03-15',
      });
      expect(provider.calls).toEqual(['2026-03-15']);
      expect(moved.household_currency).toBe(Currency.EUR);
    });

    it('PUT succeeds when the provider is down', async () => {
      const created = await crud.createBill(writeHouseholdId, userId, {
        bill_date: '2026-03-02',
        currency: Currency.EUR,
        total_amount: 200,
        items: items(),
      } as never);

      const res = await withDownProvider(() =>
        crud.updateBill(created.id, writeHouseholdId, {
          currency: Currency.MDL,
          bill_date: '2026-02-21',
        }),
      );

      expect(res.bill_date).toBe('2026-02-21');
      expect(res.household_amount).toBeNull();
    });
  });
});
