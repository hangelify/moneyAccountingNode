import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { BillSource } from '../../types/bill-source.enum';
import { BillStatus } from '../../types/bill-status.enum';
import { ExchangeRateService } from '../exchange-rate';
import { StubProvider } from '../exchange-rate/testing';
import { MarketService } from '../market';
import { BillCrudService } from './bill-crud.service';
import { BillDuplicatesService } from './bill-duplicates.service';
import { BillMoveService } from './bill-move.service';
import { BillConversionService } from './household-conversion';
import { MoveBillsResponseDto } from './dto/move-bills.dto';

jest.setTimeout(30_000);

/** A line to put in a bill: its category and sub-category ids, or null. */
interface LineSpec {
  category: string | null;
  sub: string | null;
}

interface LineRow {
  category_id: string | null;
  sub_category_id: string | null;
  category_confidence: string | null;
  category_reasoning: string | null;
}

// Moving bills to another household (HAN-23): the lines are remapped onto
// the target's categories by name, the market onto the target's market.
describe('bill move (PostgreSQL)', () => {
  let orm: MikroORM;
  const userId = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  // Household A (EUR).
  const aFood = randomUUID();
  const aBread = randomUUID();
  const aMilk = randomUUID();
  const aTransport = randomUUID();
  const aTaxi = randomUUID();
  const aMisc = randomUUID();
  const aLidl = randomUUID();
  const aKaufland = randomUUID();
  // Household B (MDL).
  const bFood = randomUUID();
  const bBread = randomUUID();
  const bTransport = randomUUID();
  const bLidl = randomUUID();

  const sql = <T = unknown>(
    query: string,
    params: unknown[] = [],
  ): Promise<T> => orm.em.getConnection().execute(query, params) as Promise<T>;

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Bill move', ?, 'x')`,
      [userId, `bill-move-${userId}@example.com`],
    );
    for (const [id, currency] of [
      [a, 'EUR'],
      [b, 'MDL'],
    ]) {
      await sql(
        `insert into households (id, name, created_by, currency) values (?, 'Bill move', ?, ?)`,
        [id, userId, currency],
      );
      await sql(
        `insert into household_members (household_id, user_id, role) values (?, ?, 'owner')`,
        [id, userId],
      );
    }
    for (const [id, name, household] of [
      [aFood, 'Food', a],
      [aTransport, 'Transport', a],
      [aMisc, 'Misc', a],
      [bFood, 'food', b],
      [bTransport, 'Transport', b],
    ]) {
      await sql(
        `insert into categories (id, name, household_id) values (?, ?, ?)`,
        [id, name, household],
      );
    }
    for (const [id, name, category] of [
      [aBread, 'Bread', aFood],
      [aMilk, 'Milk', aFood],
      [aTaxi, 'Taxi', aTransport],
      [bBread, 'bread', bFood],
    ]) {
      await sql(
        `insert into sub_categories (id, name, category_id) values (?, ?, ?)`,
        [id, name, category],
      );
    }
    await sql(
      `insert into markets (id, name, city, country, address, household_id) values
         (?, 'Lidl', 'Chisinau', null, null, ?),
         (?, 'Kaufland', 'Balti', 'MD', 'Str. 1', ?),
         (?, 'LIDL', null, null, null, ?)`,
      [aLidl, a, aKaufland, a, bLidl, b],
    );
  });

  afterAll(async () => {
    const both = [a, b];
    await sql(
      `delete from bill_sub_categories where bill_id in (select id from bills where household_id in (?, ?))`,
      both,
    );
    await sql(
      'delete from bill_duplicate_dismissals where household_id in (?, ?)',
      both,
    );
    await sql('delete from bills where household_id in (?, ?)', both);
    await sql('delete from markets where household_id in (?, ?)', both);
    await sql(
      'delete from sub_categories where category_id in (select id from categories where household_id in (?, ?))',
      both,
    );
    await sql('delete from categories where household_id in (?, ?)', both);
    await sql(
      'delete from household_members where household_id in (?, ?)',
      both,
    );
    await sql('delete from households where id in (?, ?)', both);
    await sql('delete from logs where user_id = ?', [userId]);
    await sql('delete from users where id = ?', [userId]);
    await orm.close(true);
  });

  function mover(): BillMoveService {
    const fork = orm.em.fork();
    return new BillMoveService(
      fork,
      new MarketService(fork.getRepository(Market), fork),
      new ExchangeRateService(fork, new StubProvider()),
    );
  }

  function crud(): BillCrudService {
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

  /** A confirmed EUR bill of A with these lines, in order; returns its id. */
  async function makeBill(
    lines: LineSpec[] = [],
    opts: {
      market?: string | null;
      status?: BillStatus;
      imageKey?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into bills (id, household_id, bill_date, amount, status, currency, source, market_id, image_key)
       values (?, ?, '2026-11-10', 10, ?, 'EUR', ?, ?, ?)`,
      [
        id,
        a,
        opts.status ?? BillStatus.CONFIRMED,
        BillSource.MANUAL,
        opts.market ?? null,
        opts.imageKey ?? null,
      ],
    );
    for (const [i, line] of lines.entries()) {
      await sql(
        `insert into bill_sub_categories
           (id, bill_id, raw_name, product_count, amount, price_per_unit,
            sub_category_id, category_id, category_confidence, category_reasoning)
         values (?, ?, ?, 1, 1, 1, ?, ?, 0.9, 'x')`,
        [randomUUID(), id, `line ${String(i)}`, line.sub, line.category],
      );
    }
    return id;
  }

  const linesOf = (id: string): Promise<LineRow[]> =>
    sql<LineRow[]>(
      `select category_id, sub_category_id, category_confidence, category_reasoning
       from bill_sub_categories where bill_id = ? order by raw_name`,
      [id],
    );

  const billRow = async (
    id: string,
  ): Promise<{ household_id: string; market_id: string | null }> => {
    const [row] = await sql<
      { household_id: string; market_id: string | null }[]
    >('select household_id, market_id from bills where id = ?', [id]);
    if (!row) throw new Error(`No bill ${id}`);
    return row;
  };

  const move = (ids: string[]): Promise<MoveBillsResponseDto> =>
    mover().move(a, userId, { bill_ids: ids, target_household_id: b });

  it('remaps lines by pair, then by category, else clears them', async () => {
    const id = await makeBill([
      { category: aFood, sub: aBread },
      { category: aFood, sub: aMilk },
      { category: aTransport, sub: aTaxi },
      { category: aMisc, sub: null },
      { category: aFood, sub: null },
      { category: null, sub: null },
    ]);

    const res = await move([id]);

    expect(res).toEqual({
      target_household_id: b,
      bills: [
        {
          id,
          lines_total: 6,
          lines_lost_sub_category: 2,
          lines_lost_category: 1,
          already_moved: false,
        },
      ],
    });
    const lines = await linesOf(id);
    expect(lines.map((l) => [l.category_id, l.sub_category_id])).toEqual([
      [bFood, bBread],
      [bFood, null],
      [bTransport, null],
      [null, null],
      [bFood, null],
      [null, null],
    ]);
    expect(
      lines.map((l) => [
        l.category_confidence === null ? null : Number(l.category_confidence),
        l.category_reasoning,
      ]),
    ).toEqual([
      [0.9, 'x'],
      [null, null],
      [null, null],
      [null, null],
      [0.9, 'x'],
      [0.9, 'x'],
    ]);
    expect((await billRow(id)).household_id).toBe(b);
  });

  it('matches a deleted source category by name', async () => {
    const id = await makeBill([{ category: aFood, sub: aBread }]);
    await sql('update categories set deleted_at = now() where id = ?', [aFood]);
    try {
      await move([id]);
    } finally {
      await sql('update categories set deleted_at = null where id = ?', [
        aFood,
      ]);
    }

    const [line] = await linesOf(id);
    expect([line?.category_id, line?.sub_category_id]).toEqual([bFood, bBread]);
  });

  it('does not match a deleted target category', async () => {
    const id = await makeBill([{ category: aFood, sub: aBread }]);
    await sql('update categories set deleted_at = now() where id = ?', [bFood]);
    const res = await move([id]).finally(() =>
      sql('update categories set deleted_at = null where id = ?', [bFood]),
    );

    const [line] = await linesOf(id);
    expect([line?.category_id, line?.sub_category_id]).toEqual([null, null]);
    expect(res.bills[0]).toMatchObject({
      lines_lost_sub_category: 0,
      lines_lost_category: 1,
    });
  });

  it('reuses the target market ignoring case', async () => {
    const id = await makeBill([], { market: aLidl });

    await move([id]);

    expect((await billRow(id)).market_id).toBe(bLidl);
  });

  it('creates a missing market with its details', async () => {
    const id = await makeBill([], { market: aKaufland });

    await move([id]);

    const { market_id } = await billRow(id);
    expect(market_id).not.toBe(aKaufland);
    const [market] = await sql<Record<string, unknown>[]>(
      'select name, city, country, address, household_id, deleted_at from markets where id = ?',
      [market_id],
    );
    expect(market).toEqual({
      name: 'Kaufland',
      city: 'Balti',
      country: 'MD',
      address: 'Str. 1',
      household_id: b,
      deleted_at: null,
    });
  });

  it('leaves a bill without market or with a deleted market without one', async () => {
    const gone = randomUUID();
    await sql(
      `insert into markets (id, name, household_id, deleted_at) values (?, 'Gone', ?, now())`,
      [gone, a],
    );
    const none = await makeBill();
    const deleted = await makeBill([], { market: gone });

    await move([none, deleted]);

    expect((await billRow(none)).market_id).toBeNull();
    expect((await billRow(deleted)).market_id).toBeNull();
    const gones = await sql<unknown[]>(
      `select id from markets where household_id = ? and lower(name) = 'gone'`,
      [b],
    );
    expect(gones).toEqual([]);
  });

  it('moves a bill without lines', async () => {
    const id = await makeBill();

    const res = await move([id]);

    expect(res.bills).toEqual([
      {
        id,
        lines_total: 0,
        lines_lost_sub_category: 0,
        lines_lost_category: 0,
        already_moved: false,
      },
    ]);
  });

  it('answers in the order of bill_ids', async () => {
    const ids = [await makeBill(), await makeBill(), await makeBill()].sort();
    const order = [ids[1], ids[2], ids[0]] as string[];

    const res = await move(order);

    expect(res.bills.map((x) => x.id)).toEqual(order);
  });

  it('drops duplicate dismissals of moved bills', async () => {
    const moved = await makeBill();
    const other = await makeBill();
    const other1 = await makeBill();
    const other2 = await makeBill();
    const pair = (x: string, y: string): string[] => (x < y ? [x, y] : [y, x]);
    for (const [x, y] of [pair(moved, other), pair(other1, other2)]) {
      await sql(
        `insert into bill_duplicate_dismissals (household_id, bill_id, other_bill_id) values (?, ?, ?)`,
        [a, x, y],
      );
    }

    await move([moved]);

    const rows = await sql<{ bill_id: string; other_bill_id: string }[]>(
      `select bill_id, other_bill_id from bill_duplicate_dismissals
       where bill_id in (?, ?, ?, ?)`,
      [moved, other, other1, other2],
    );
    expect(rows.map((r) => [r.bill_id, r.other_bill_id])).toEqual([
      pair(other1, other2),
    ]);
  });

  it('writes one log entry', async () => {
    const ids = [await makeBill(), await makeBill()];

    await move(ids);

    const logs = await sql<{ metadata: { bill_ids: string[] } }[]>(
      `select metadata from logs
       where context = 'BillMove' and user_id = ? and metadata->'bill_ids' @> ?::jsonb`,
      [userId, JSON.stringify(ids)],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.metadata).toMatchObject({
      source_household_id: a,
      target_household_id: b,
      bill_ids: ids,
    });
  });

  it('shows the bill in the target lists, not the source ones', async () => {
    const id = await makeBill();

    await move([id]);

    const inA = await crud().listBills(a, {});
    const inB = await crud().listBills(b, {});
    expect(inA.data.map((x) => x.id)).not.toContain(id);
    expect(inB.data.map((x) => x.id)).toContain(id);
  });

  it('keeps the draft photo readable from the target', async () => {
    const key = `ai/images/${a}/x.jpg`;
    const id = await makeBill([], {
      status: BillStatus.DRAFT,
      imageKey: key,
    });

    await move([id]);

    await expect(crud().getDraftImageKey(id, b)).resolves.toBe(key);
  });
});
