import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { BillSource } from '../../types/bill-source.enum';
import { BACKFILL_BILL_SOURCE } from '../../migrations/Migration20261109140000_AddBillSource';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { StubProvider } from '../exchange-rate/testing/stub-exchange-rate.provider';
import { MarketService } from '../market/market.service';
import { BillCrudService } from './bill-crud.service';
import { BillDuplicatesService } from './bill-duplicates.service';
import { BillConversionService } from './household-conversion';
import { ParsedBillResponseDto } from './dto/parsed-bill-response.dto';

jest.setTimeout(30_000);

// Every bill records where it came from: a photo, a hand entry or a bank
// import (HAN-65).
describe('bill source (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  let householdId: string;
  let subCategoryId: string;

  const sql = (query: string, params: unknown[] = []) =>
    orm.em.getConnection().execute(query, params);

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
    userId = randomUUID();
    householdId = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Source', ?, 'x')`,
      [userId, `source-${userId}@example.com`],
    );
    await sql(
      `insert into households (id, name, created_by, currency) values (?, 'Source', ?, 'EUR')`,
      [householdId, userId],
    );
    const categoryId = randomUUID();
    subCategoryId = randomUUID();
    await sql(
      `insert into categories (id, name, household_id) values (?, 'Food', ?)`,
      [categoryId, householdId],
    );
    await sql(
      `insert into sub_categories (id, name, category_id) values (?, 'Bread', ?)`,
      [subCategoryId, categoryId],
    );
  });

  afterAll(async () => {
    if (!orm) return;
    await sql(
      `delete from bill_sub_categories where bill_id in (select id from bills where household_id = ?)`,
      [householdId],
    );
    await sql('delete from bills where household_id = ?', [householdId]);
    await sql('delete from ai_requests where user_id = ?', [userId]);
    await sql('delete from sub_categories where id = ?', [subCategoryId]);
    await sql('delete from categories where household_id = ?', [householdId]);
    await sql('delete from households where id = ?', [householdId]);
    await sql('delete from users where id = ?', [userId]);
    await orm.close(true);
  });

  function crud() {
    const fork = orm.em.fork();
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

  const sourceOf = async (id: string) =>
    (
      (await sql('select source from bills where id = ?', [id])) as [
        { source: string },
      ]
    )[0].source;

  it('records a bill typed by hand as manual', async () => {
    const bill = await crud().createBill(householdId, userId, {
      bill_date: '2026-11-01',
      total_amount: 3,
      items: [{ sub_category_id: subCategoryId, product_count: 1, amount: 3 }],
    });

    expect(bill.source).toBe(BillSource.MANUAL);
    expect(await sourceOf(bill.id)).toBe('manual');
  });

  it('records a draft read from a photo as photo', async () => {
    const parsed = {
      market_name: null,
      bill_date: '2026-11-01',
      currency: 'EUR',
      total_amount: 3,
      fiscal_register_id: null,
      fiscal_receipt_number: null,
      purchase_time: null,
      items: [],
    } as unknown as ParsedBillResponseDto;

    const { id } = await crud().createDraftFromParsed(
      householdId,
      userId,
      parsed,
    );

    expect(await sourceOf(id)).toBe('photo');
  });

  it('lists each bill with its source', async () => {
    await crud().createBill(householdId, userId, {
      bill_date: '2026-11-02',
      total_amount: 4,
      items: [{ sub_category_id: subCategoryId, product_count: 1, amount: 4 }],
    });

    const { data } = await crud().listBills(householdId, {});

    expect(data.length).toBeGreaterThan(0);
    for (const row of data) expect(row.source).toBe(BillSource.MANUAL);
  });

  it('backfills photo for bills with an AI request and manual for the rest', async () => {
    const aiRequestId = randomUUID();
    await sql(
      `insert into ai_requests
         (id, task_name, user_id, status, required_capabilities, prompt)
       values (?, 'bill.parse', ?, 'SUCCESS', '[]', '{"messages":[]}')`,
      [aiRequestId, userId],
    );
    const fromPhoto = randomUUID();
    const byHand = randomUUID();
    for (const [id, ai] of [
      [fromPhoto, aiRequestId],
      [byHand, null],
    ] as const) {
      await sql(
        `insert into bills (id, household_id, bill_date, amount, status, currency, ai_request_id, source)
         values (?, ?, '2026-11-03', 5, 'confirmed', 'EUR', ?, 'bank')`,
        [id, householdId, ai],
      );
    }

    await sql(BACKFILL_BILL_SOURCE);

    expect(await sourceOf(fromPhoto)).toBe('photo');
    expect(await sourceOf(byHand)).toBe('manual');
  });
});
