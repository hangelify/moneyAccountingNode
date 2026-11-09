import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { StubProvider } from '../exchange-rate/testing/stub-exchange-rate.provider';
import { MarketService } from '../market/market.service';
import { BillCrudService } from './bill-crud.service';
import { BillDuplicatesService } from './bill-duplicates.service';
import { BillConversionService } from './household-conversion';

jest.setTimeout(30_000);

// The bill list pages in a total order: bills of one day by creation time,
// then by id, so no bill shows on two pages or on none.
describe('bill list order (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  let householdId: string;

  const sql = (query: string, params: unknown[] = []) =>
    orm.em.getConnection().execute(query, params);

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
    userId = randomUUID();
    householdId = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Order', ?, 'x')`,
      [userId, `order-${userId}@example.com`],
    );
    await sql(
      `insert into households (id, name, created_by, currency) values (?, 'Order', ?, 'EUR')`,
      [householdId, userId],
    );
  });

  beforeEach(async () => {
    await sql('delete from bills where household_id = ?', [householdId]);
    await sql('delete from markets where household_id = ?', [householdId]);
  });

  afterAll(async () => {
    if (!orm) return;
    await sql('delete from bills where household_id = ?', [householdId]);
    await sql('delete from markets where household_id = ?', [householdId]);
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

  const insertBill = async (
    id: string,
    billDate: string,
    createdAt: string,
    marketId: string | null = null,
  ) => {
    await sql(
      `insert into bills (id, household_id, created_by_user_id, market_id, bill_date, amount, status, currency, created_at)
       values (?, ?, ?, ?, ?, 10, 'confirmed', 'EUR', ?)`,
      [id, householdId, userId, marketId, billDate, createdAt],
    );
  };

  it('orders bills of one day by creation time, then id, newest first', async () => {
    // Inserted oldest first, so the table order is the reverse of the list.
    const [a, b] = [randomUUID(), randomUUID()].sort();
    const early = randomUUID();
    const late = randomUUID();
    await insertBill(early, '2026-11-01', '2026-11-01T08:00:00Z');
    await insertBill(a, '2026-11-01', '2026-11-01T09:00:00Z');
    await insertBill(b, '2026-11-01', '2026-11-01T09:00:00Z');
    await insertBill(late, '2026-11-01', '2026-11-01T10:00:00Z');
    const newer = randomUUID();
    await insertBill(newer, '2026-11-02', '2026-11-01T07:00:00Z');

    const { data } = await crud().listBills(householdId, {});

    expect(data.map((x) => x.id)).toEqual([newer, late, b, a, early]);
  });

  it('shows each bill on exactly one page', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = randomUUID();
      ids.push(id);
      await insertBill(id, '2026-11-01', '2026-11-01T09:00:00Z');
    }

    const paged: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const { data } = await crud().listBills(householdId, { page, limit: 2 });
      paged.push(...data.map((x) => x.id));
    }

    expect(paged).toEqual([...ids].sort().reverse());
  });

  it('keeps showing a deleted market on its bills', async () => {
    const marketId = randomUUID();
    await sql(
      `insert into markets (id, name, household_id, deleted_at) values (?, 'Gone', ?, now())`,
      [marketId, householdId],
    );
    const id = randomUUID();
    await insertBill(id, '2026-11-01', '2026-11-01T09:00:00Z', marketId);

    const { data } = await crud().listBills(householdId, {});

    expect(data[0].market).toMatchObject({ id: marketId, name: 'Gone' });
  });
});
