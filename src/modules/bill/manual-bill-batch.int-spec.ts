import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { BillSource } from '../../types/bill-source.enum';
import { BillStatus } from '../../types/bill-status.enum';
import { Currency } from '../../types/currency.enum';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { StubProvider } from '../exchange-rate/testing/stub-exchange-rate.provider';
import { MarketService } from '../market/market.service';
import { BillCrudService } from './bill-crud.service';
import { BillDashboardService } from './bill-dashboard.service';
import { BillDuplicatesService } from './bill-duplicates.service';
import { BillConversionService } from './household-conversion';
import { ManualBillBatchService } from './manual-bill-batch.service';
import { SpendingBreakdownService } from './spending-breakdown.service';
import { ManualBatchDto, ManualBatchRowDto } from './dto/manual-batch.dto';
import { ParsedBillResponseDto } from './dto/parsed-bill-response.dto';

jest.setTimeout(30_000);

// The quick-entry form saves several manual expenses at once: one confirmed
// one-line bill per row, all or nothing, and a resent submit saves nothing
// new (HAN-48).
describe('manual expense batch (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  // Household A (EUR) is written to; B owns the foreign ids.
  const a = { id: '', food: '', bread: '', fun: '', market: '' };
  const b = { id: '', food: '', bread: '', market: '' };

  const sql = (query: string, params: unknown[] = []) =>
    orm.em.getConnection().execute(query, params);

  async function household(name: string) {
    const id = randomUUID();
    await sql(
      `insert into households (id, name, created_by, currency) values (?, ?, ?, 'EUR')`,
      [id, name, userId],
    );
    return id;
  }
  async function category(householdId: string, name: string) {
    const id = randomUUID();
    await sql(
      `insert into categories (id, name, household_id) values (?, ?, ?)`,
      [id, name, householdId],
    );
    return id;
  }
  async function subCategory(categoryId: string, name: string) {
    const id = randomUUID();
    await sql(
      `insert into sub_categories (id, name, category_id) values (?, ?, ?)`,
      [id, name, categoryId],
    );
    return id;
  }
  async function market(householdId: string, name: string, deleted = false) {
    const id = randomUUID();
    await sql(
      `insert into markets (id, name, household_id, deleted_at) values (?, ?, ?, ?)`,
      [id, name, householdId, deleted ? new Date() : null],
    );
    return id;
  }

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
    userId = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Manual', ?, 'x')`,
      [userId, `manual-${userId}@example.com`],
    );
    a.id = await household('Manual A');
    a.food = await category(a.id, 'Food');
    a.bread = await subCategory(a.food, 'Bread');
    a.fun = await category(a.id, 'Fun');
    a.market = await market(a.id, 'Corner shop');
    b.id = await household('Manual B');
    b.food = await category(b.id, 'Food');
    b.bread = await subCategory(b.food, 'Bread');
    b.market = await market(b.id, 'Other shop');
  });

  const households = () => [a.id, b.id];

  beforeEach(async () => {
    for (const hid of households()) {
      await sql(
        `delete from bill_sub_categories where bill_id in (select id from bills where household_id = ?)`,
        [hid],
      );
      await sql('delete from bills where household_id = ?', [hid]);
      await sql(
        `delete from markets where household_id = ? and id not in (?, ?)`,
        [hid, a.market, b.market],
      );
    }
  });

  afterAll(async () => {
    if (!orm) return;
    for (const hid of households()) {
      await sql(
        `delete from bill_sub_categories where bill_id in (select id from bills where household_id = ?)`,
        [hid],
      );
      await sql('delete from bills where household_id = ?', [hid]);
      await sql('delete from markets where household_id = ?', [hid]);
      await sql(
        `delete from sub_categories where category_id in (select id from categories where household_id = ?)`,
        [hid],
      );
      await sql('delete from categories where household_id = ?', [hid]);
      await sql('delete from households where id = ?', [hid]);
    }
    await sql('delete from users where id = ?', [userId]);
    await orm.close(true);
  });

  function services() {
    const fork = orm.em.fork();
    const rates = new ExchangeRateService(fork, new StubProvider());
    const conversion = new BillConversionService(fork, rates);
    const markets = new MarketService(fork.getRepository(Market), fork);
    return {
      batch: new ManualBillBatchService(fork, markets, rates, conversion),
      crud: new BillCrudService(
        fork.getRepository(Bill),
        fork.getRepository(Market),
        fork.getRepository(SubCategory),
        fork,
        rates,
        conversion,
        new BillDuplicatesService(fork),
        markets,
      ),
      dashboard: new BillDashboardService(fork, rates),
      breakdown: new SpendingBreakdownService(fork, rates),
      duplicates: new BillDuplicatesService(fork),
    };
  }

  const row = (over: Partial<ManualBatchRowDto> = {}): ManualBatchRowDto => ({
    bill_date: '2026-11-05',
    amount: 2.5,
    category_id: a.food,
    ...over,
  });
  const batch = (
    rows: ManualBatchRowDto[],
    key = randomUUID(),
  ): ManualBatchDto => ({ client_batch_id: key, rows });
  const save = (dto: ManualBatchDto, householdId = a.id) =>
    services().batch.createBatch(householdId, userId, dto);

  /** The 400 body of a rejected batch. */
  async function rejection(dto: ManualBatchDto) {
    const err = await save(dto).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as {
      statusCode: number;
      message: string;
      errors: { index: number; field: string; message: string }[];
    };
  }

  const billsOfKey = async (key: string) =>
    (await sql(
      `select id from bills where client_batch_id = ? order by client_batch_index`,
      [key],
    )) as { id: string }[];

  it('creates one confirmed manual bill per row', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ amount: i + 1, bill_date: `2026-11-0${(i % 9) + 1}` }),
    );
    rows[0] = row({ note: 'coffee', sub_category_id: a.bread });
    rows[1] = row({ sub_category_id: a.bread });
    rows[2] = row({ category_id: a.fun });

    const { created, body } = await save(batch(rows));

    expect(created).toBe(true);
    expect(body.bills).toHaveLength(10);
    expect(body.bills.every((x) => x.source === BillSource.MANUAL)).toBe(true);
    expect(body.bills.every((x) => x.status === BillStatus.CONFIRMED)).toBe(
      true,
    );
    expect(body.bills.map((x) => x.total_amount)).toEqual(
      rows.map((r) => r.amount),
    );
    const lines = (await sql(
      `select b.client_batch_index, b.status, b.source, l.raw_name,
              l.product_count, l.amount::float8 as amount,
              l.category_id, l.sub_category_id
       from bills b join bill_sub_categories l on l.bill_id = b.id
       where b.client_batch_id = ? order by b.client_batch_index`,
      [body.client_batch_id],
    )) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(10);
    expect(lines.map((l) => l.client_batch_index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(lines[0]).toMatchObject({
      raw_name: 'coffee',
      category_id: a.food,
      sub_category_id: a.bread,
      product_count: 1,
      amount: rows[0].amount,
    });
    expect(lines[1]).toMatchObject({ raw_name: 'Bread' });
    expect(lines[2]).toMatchObject({
      raw_name: 'Fun',
      category_id: a.fun,
      sub_category_id: null,
    });
  });

  it("defaults the currency to the household's", async () => {
    const { body } = await save(
      batch([row(), row({ currency: Currency.MDL })]),
    );

    expect(body.bills.map((x) => x.currency)).toEqual([
      Currency.EUR,
      Currency.MDL,
    ]);
    expect(body.bills[0].household_amount).toBe(2.5);
  });

  it('shows the bills in the list, the dashboard and the breakdown', async () => {
    const { body } = await save(
      batch([
        row({ amount: 4, category_id: a.fun }),
        row({ amount: 6, sub_category_id: a.bread }),
      ]),
    );
    const s = services();

    const { data } = await s.crud.listBills(a.id, {});
    expect(data.map((x) => x.id).sort()).toEqual(
      body.bills.map((x) => x.id).sort(),
    );

    const dashboard = await s.dashboard.getDashboard(a.id, {
      type: 'month',
      year: 2026,
      month: 11,
    });
    expect(dashboard.bills.map((x) => x.id).sort()).toEqual(
      body.bills.map((x) => x.id).sort(),
    );

    const breakdown = await s.breakdown.getSpendingBreakdown(a.id, {
      period: 'custom',
      from: '2026-11-01',
      to: '2026-11-30',
    });
    const eur = breakdown.by_currency.find((c) => c.currency === Currency.EUR)!;
    const totals = Object.fromEntries(
      eur.categories.map((c) => [c.id ?? 'none', c.total]),
    );
    expect(totals).toEqual({ [a.fun]: 4, [a.food]: 6 });
  });

  it('rejects the batch on a bad row and saves nothing', async () => {
    const dto = batch([
      row({ market_name: 'Brand new shop' }),
      row(),
      row({ category_id: b.food }),
    ]);

    const body = await rejection(dto);

    expect(body).toMatchObject({
      statusCode: 400,
      message: 'Some rows are invalid',
      errors: [{ index: 2, field: 'category_id' }],
    });
    expect(body.errors).toHaveLength(1);
    expect(await billsOfKey(dto.client_batch_id)).toEqual([]);
    expect(
      await sql(`select id from markets where name = 'Brand new shop'`),
    ).toEqual([]);
  });

  it('reports every bad row', async () => {
    const body = await rejection(
      batch([
        row(),
        row({ category_id: randomUUID() }),
        row(),
        row({ sub_category_id: b.bread }),
      ]),
    );

    expect(body.errors.map((e) => [e.index, e.field])).toEqual([
      [1, 'category_id'],
      [3, 'sub_category_id'],
    ]);
  });

  it('rejects a sub-category of another category', async () => {
    const body = await rejection(
      batch([row({ category_id: a.fun, sub_category_id: a.bread })]),
    );

    expect(body.errors).toEqual([
      {
        index: 0,
        field: 'sub_category_id',
        message: 'Sub-category is not in this category',
      },
    ]);
  });

  it("rejects another household's or a deleted market", async () => {
    const gone = await market(a.id, 'Gone shop', true);

    const body = await rejection(
      batch([row({ market_id: b.market }), row({ market_id: gone })]),
    );

    expect(body.errors.map((e) => [e.index, e.field])).toEqual([
      [0, 'market_id'],
      [1, 'market_id'],
    ]);
  });

  it('answers a resent submit with the bills it saved', async () => {
    const dto = batch([row(), row({ amount: 7 })]);
    const first = await save(dto);

    const again = await save(dto);

    expect(again.created).toBe(false);
    expect(again.body.bills.map((x) => x.id)).toEqual(
      first.body.bills.map((x) => x.id),
    );
    expect(await billsOfKey(dto.client_batch_id)).toHaveLength(2);
  });

  it('does not bring back a deleted bill on a resend', async () => {
    const dto = batch([row(), row(), row()]);
    const first = await save(dto);
    await services().crud.softDeleteBill(first.body.bills[0].id, a.id);

    const again = await save(dto);

    expect(again.body.bills.map((x) => x.id)).toEqual(
      first.body.bills.map((x) => x.id),
    );
    const [deleted] = (await sql('select deleted_at from bills where id = ?', [
      first.body.bills[0].id,
    ])) as { deleted_at: Date | null }[];
    expect(deleted.deleted_at).not.toBeNull();
  });

  it('answers a resend after its category was deleted', async () => {
    const doomed = await category(a.id, 'Doomed');
    const dto = batch([row({ category_id: doomed })]);
    await save(dto);
    await sql('update categories set deleted_at = now() where id = ?', [
      doomed,
    ]);

    const again = await save(dto);

    expect(again.created).toBe(false);
    expect(again.body.bills).toHaveLength(1);
  });

  it('saves one set of bills for two concurrent identical submits', async () => {
    const dto = batch([row(), row(), row()]);

    const [x, y] = await Promise.all([save(dto), save(dto)]);

    expect([x.created, y.created].sort()).toEqual([false, true]);
    expect(x.body.bills.map((v) => v.id)).toEqual(
      y.body.bills.map((v) => v.id),
    );
    expect(await billsOfKey(dto.client_batch_id)).toHaveLength(3);
  });

  it('answers with the saved bills when the key is taken between lookup and write', async () => {
    const dto = batch([row(), row()]);
    const first = await save(dto);
    // The second submit looked before the first one committed.
    const late = services().batch;
    jest
      .spyOn(late as unknown as { replay: () => Promise<unknown> }, 'replay')
      .mockResolvedValueOnce(null);

    const again = await late.createBatch(a.id, userId, dto);

    expect(again.created).toBe(false);
    expect(again.body.bills.map((x) => x.id)).toEqual(
      first.body.bills.map((x) => x.id),
    );
    expect(await billsOfKey(dto.client_batch_id)).toHaveLength(2);
  });

  it('keeps batch keys apart between households', async () => {
    const key = randomUUID();
    const inA = await save(batch([row()], key));

    const inB = await save(batch([row({ category_id: b.food })], key), b.id);

    expect(inB.created).toBe(true);
    expect(inB.body.bills[0].id).not.toBe(inA.body.bills[0].id);
  });

  it('uses one market for names that differ only in case', async () => {
    await market(a.id, 'Kiosk', true);

    const { body } = await save(
      batch([row({ market_name: 'Kiosk' }), row({ market_name: 'kiosk' })]),
    );

    expect(body.bills[0].market?.id).toBeDefined();
    expect(body.bills[1].market?.id).toBe(body.bills[0].market?.id);
    const live = (await sql(
      `select id from markets where household_id = ? and lower(name) = 'kiosk' and deleted_at is null`,
      [a.id],
    )) as { id: string }[];
    expect(live.map((m) => m.id)).toEqual([body.bills[0].market!.id]);
  });

  it('uses the market named by id', async () => {
    const { body } = await save(batch([row({ market_id: a.market })]));

    expect(body.bills[0].market).toMatchObject({
      id: a.market,
      name: 'Corner shop',
    });
  });

  it('lets a photo of the same purchase find the manual bill', async () => {
    const { body } = await save(
      batch([row({ amount: 12.5, market_id: a.market })]),
    );
    const s = services();
    const parsed = {
      market_name: 'Corner shop',
      bill_date: '2026-11-05',
      currency: 'EUR',
      total_amount: 12.5,
      fiscal_register_id: null,
      fiscal_receipt_number: null,
      purchase_time: null,
      items: [],
    } as unknown as ParsedBillResponseDto;
    const draft = await s.crud.createDraftFromParsed(a.id, userId, parsed);

    const candidates = await s.duplicates.findCandidates(
      a.id,
      {
        amount: 12.5,
        currency: Currency.EUR,
        bill_date: '2026-11-05',
        market_id: null,
        market_name: 'Corner shop',
        fiscal_register_id: null,
        fiscal_receipt_number: null,
        purchase_time: null,
      },
      { excludeBillId: draft.id },
    );

    expect(candidates.map((c) => c.id)).toContain(body.bills[0].id);
  });
});
