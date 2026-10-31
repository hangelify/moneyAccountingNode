import { randomUUID } from 'node:crypto';
import { MikroORM, EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
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
    for (const key of Object.keys(id) as Array<keyof typeof id>) {
      id[key] = bills[key].id;
    }
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = orm.em.getConnection();
    const hids = [householdId, mdlHouseholdId];
    await conn.execute(
      'DELETE FROM bill_sub_categories WHERE bill_id IN (SELECT id FROM bills WHERE household_id IN (?, ?))',
      hids,
    );
    await conn.execute('DELETE FROM bills WHERE household_id IN (?, ?)', hids);
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
});
