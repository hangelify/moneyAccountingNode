import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { NotFoundException } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { EXCHANGE_RATE_PROVIDER, ExchangeRateService } from '../exchange-rate';
import { StubProvider } from '../exchange-rate/testing';
import { MarketService } from '../market';
import { BillCrudService } from './bill-crud.service';
import { BillDuplicatesService } from './bill-duplicates.service';
import { BillConversionService } from './household-conversion';
import type { ListBillsQueryDto } from './dto/list-bills-query.dto';
import type { BillsByCategoryResponseDto } from './dto/bills-by-category-response.dto';

jest.setTimeout(60_000);

const SOURCE = 'TEST-BBC';
// MDL per unit; HUF is never published, so a HUF bill has no rate.
const RATES: Record<string, Record<string, number>> = {
  '2026-10-01': { EUR: 20.0, USD: 18.0 },
};

/** `[category, amount, sub-category?]`. */
type Line = [string, number, string?];

// Bills of a category (HAN-149): bills with a line in the category, whole,
// with the category's contribution and the total for the filters.
describe('bills by category (PostgreSQL)', () => {
  let orm: MikroORM;
  let crud: BillCrudService;
  const userId = randomUUID();
  const hid = randomUUID();
  const otherHid = randomUUID();
  let food = '';
  let home = '';
  let otherFood = '';
  const b = { b1: '', b2: '', b3: '', b4: '', b5: '', b6: '', b7: '' };

  const sql = <T = unknown>(
    query: string,
    params: unknown[] = [],
  ): Promise<T> => orm.em.getConnection().execute(query, params) as Promise<T>;

  async function category(householdId: string, name: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into categories (id, name, household_id) values (?, ?, ?)`,
      [id, name, householdId],
    );
    return id;
  }

  async function bill(
    day: string,
    lines: Line[],
    opts: {
      currency?: string;
      duplicateOf?: string;
      deleted?: boolean;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into bills (id, household_id, created_by_user_id, bill_date, amount,
                          status, currency, deleted_at, duplicate_of_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        hid,
        userId,
        day,
        lines.reduce((s, [, amount]) => s + amount, 0),
        opts.duplicateOf ? 'duplicate' : 'confirmed',
        opts.currency ?? 'EUR',
        opts.deleted ? new Date() : null,
        opts.duplicateOf ?? null,
      ],
    );
    for (const [cat, amount, sub] of lines) {
      await sql(
        `insert into bill_sub_categories (id, bill_id, category_id, sub_category_id, raw_name, product_count, amount)
         values (?, ?, ?, ?, 'item', 1, ?)`,
        [randomUUID(), id, cat, sub ?? null, amount],
      );
    }
    return id;
  }

  beforeAll(async () => {
    const provider = new StubProvider(SOURCE);
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
      providers: [
        BillCrudService,
        MarketService,
        BillConversionService,
        BillDuplicatesService,
      ],
    })
      .overrideProvider(EXCHANGE_RATE_PROVIDER)
      .useValue(provider)
      .compile();
    orm = mod.get(MikroORM);
    crud = mod.get(BillCrudService);
    await mod
      .get(ExchangeRateService)
      .ensureDays(Object.keys(RATES), { max: 10 });

    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Bbc', ?, 'x')`,
      [userId, `bills-by-category-${userId}@example.com`],
    );
    for (const id of [hid, otherHid]) {
      await sql(
        `insert into households (id, name, created_by, currency) values (?, 'Bbc', ?, 'EUR')`,
        [id, userId],
      );
    }
    food = await category(hid, 'Food');
    home = await category(hid, 'Home');
    otherFood = await category(otherHid, 'Food');

    b.b1 = await bill('2026-10-05', [
      [food, 30],
      [home, 50],
    ]);
    b.b2 = await bill('2026-10-20', [[food, 12.34]]);
    b.b3 = await bill('2026-10-21', [[food, 10]], { currency: 'HUF' });
    b.b4 = await bill('2026-10-22', [[home, 5]]);
    b.b5 = await bill('2026-11-02', [[food, 7]]);
    b.b6 = await bill('2026-10-23', [[food, 9]], { duplicateOf: b.b2 });
    b.b7 = await bill('2026-10-24', [[food, 4]], { deleted: true });
  });

  afterAll(async () => {
    const arr = `{${hid},${otherHid}}`;
    const inHh = 'household_id = any(?::uuid[])';
    await sql(
      `delete from bill_sub_categories where bill_id in (select id from bills where ${inHh})`,
      [arr],
    );
    await sql(
      `delete from bills where ${inHh} and duplicate_of_id is not null`,
      [arr],
    );
    await sql(`delete from bills where ${inHh}`, [arr]);
    await sql(
      `delete from sub_categories where category_id in (select id from categories where ${inHh})`,
      [arr],
    );
    await sql(`delete from categories where ${inHh}`, [arr]);
    await sql(`delete from households where id = any(?::uuid[])`, [arr]);
    await sql('delete from users where id = ?', [userId]);
    await sql('delete from exchange_rates where source = ?', [SOURCE]);
    await sql('delete from exchange_rate_days where source = ?', [SOURCE]);
    await orm.close(true);
  });

  const OCTOBER = {
    date_from: '2026-10-01',
    date_to: '2026-10-31',
  } satisfies ListBillsQueryDto;
  const list = (
    filters: ListBillsQueryDto = OCTOBER,
    categoryId = food,
  ): Promise<BillsByCategoryResponseDto> =>
    crud.listBillsByCategory(hid, categoryId, filters);
  const ids = (r: { data: { id: string }[] }): string[] =>
    r.data.map((x) => x.id);

  it('lists bills with a Food line, whole, with the Food contribution', async () => {
    const r = await list();
    expect(ids(r)).toEqual([b.b3, b.b2, b.b1]);
    const b1 = r.data.find((x) => x.id === b.b1);
    expect(b1?.total_amount).toBe(80);
    expect(b1?.category_amount).toBe(30);
    expect(r.data.find((x) => x.id === b.b2)?.category_amount).toBe(12.34);
  });

  it('a line without a rate: null contribution, out of the total, counted', async () => {
    const r = await list();
    expect(r.data.find((x) => x.id === b.b3)?.category_amount).toBeNull();
    expect(r.category_total).toBe(42.34);
    expect(r.unconverted_lines).toBe(1);
  });

  it('combines with other filters; the total follows them', async () => {
    const r = await list({ ...OCTOBER, amount_range: ['gt_50'] });
    expect(ids(r)).toEqual([b.b1]);
    expect(r.category_total).toBe(30);
    expect(r.meta.total).toBe(1);
  });

  it('excludes duplicates by default and includes them on request', async () => {
    expect(ids(await list())).not.toContain(b.b6);
    const r = await list({ ...OCTOBER, include_duplicates: true });
    expect(ids(r)).toContain(b.b6);
    expect(r.category_total).toBe(51.34);
  });

  it('never lists deleted bills', async () => {
    const r = await list({ include_duplicates: true });
    expect(ids(r)).not.toContain(b.b7);
  });

  it('paginates; the total covers every page', async () => {
    const r = await list({ ...OCTOBER, limit: 1, page: 2 });
    expect(ids(r)).toEqual([b.b2]);
    expect(r.meta).toEqual({ total: 3, page: 2, limit: 1, total_pages: 3 });
    expect(r.category_total).toBe(42.34);
  });

  it('returns the category ref and the household currency', async () => {
    const r = await list();
    expect(r.category).toEqual({ id: food, name: 'Food', archived: false });
    expect(r.household_currency).toBe('EUR');
  });

  it('an archived category still lists its bills', async () => {
    const archived = await category(hid, 'Archived');
    const id = await bill('2026-10-10', [[archived, 3]]);
    await sql(`update categories set deleted_at = now() where id = ?`, [
      archived,
    ]);
    const r = await list(OCTOBER, archived);
    expect(r.category.archived).toBe(true);
    expect(ids(r)).toEqual([id]);
  });

  it('rounds the total per sub-category, as the limits report does', async () => {
    // USD → EUR = 0.9: each 0.05 USD line is 0.045 EUR. Per sub-category
    // (as fetchSpent): 0.05 + 0.05 = 0.10; one rounding of the sum: 0.09.
    const snacks = await category(hid, 'Snacks');
    const subs: string[] = [];
    for (const name of ['chips', 'nuts']) {
      const id = randomUUID();
      await sql(
        `insert into sub_categories (id, name, category_id) values (?, ?, ?)`,
        [id, name, snacks],
      );
      subs.push(id);
    }
    await bill(
      '2026-10-02',
      subs.map((sub): Line => [snacks, 0.05, sub]),
      { currency: 'USD' },
    );
    const r = await list(OCTOBER, snacks);
    expect(r.category_total).toBe(0.1);
    expect(r.data[0]?.category_amount).toBe(0.09);
  });

  it("rejects another household's category", async () => {
    await expect(list(OCTOBER, otherFood)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects an unknown category', async () => {
    await expect(list(OCTOBER, randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
