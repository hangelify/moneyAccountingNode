import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../src/mikro-orm.config';
import { Migration20261109120000_UniqueMarketNames } from '../src/migrations/Migration20261109120000_UniqueMarketNames';

// Before the unique index, a household could hold markets whose names differ
// only in case. The migration moves their bills to the oldest one and soft
// deletes the rest. Each test runs in a transaction that is rolled back; the
// index the migration builds is dropped first so duplicates can be inserted.
describe('UniqueMarketNames migration (PostgreSQL)', () => {
  let orm: MikroORM;
  let trx: Awaited<
    ReturnType<ReturnType<MikroORM['em']['getConnection']>['begin']>
  >;

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
  });

  afterAll(async () => {
    await orm.close();
  });

  const conn = () => orm.em.getConnection();
  const sql = (query: string, params: unknown[] = []) =>
    conn().execute(query, params, 'all', trx);

  beforeEach(async () => {
    trx = await conn().begin();
    await sql('drop index "markets_household_id_lower_name_unique"');
  });

  afterEach(async () => {
    await conn().rollback(trx);
  });

  const runMigration = async () => {
    const migration = new Migration20261109120000_UniqueMarketNames(
      orm.em.getDriver(),
      orm.config,
    );
    migration.up();
    for (const query of migration.getQueries()) {
      await sql(query as string);
    }
  };

  const setup = async () => {
    const userId = randomUUID();
    const householdId = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'P38', ?, 'x')`,
      [userId, `p38-${userId}@example.com`],
    );
    await sql(
      `insert into households (id, name, created_by, currency) values (?, 'P38', ?, 'EUR')`,
      [householdId, userId],
    );
    return { userId, householdId };
  };

  const market = async (
    householdId: string,
    name: string,
    createdAt: string,
    deleted = false,
  ): Promise<string> => {
    const id = randomUUID();
    await sql(
      `insert into markets (id, name, household_id, created_at, deleted_at) values (?, ?, ?, ?, ${deleted ? 'now()' : 'null'})`,
      [id, name, householdId, createdAt],
    );
    return id;
  };

  const bill = async (
    householdId: string,
    userId: string,
    marketId: string,
  ): Promise<string> => {
    const id = randomUUID();
    await sql(
      `insert into bills (id, household_id, created_by_user_id, market_id, bill_date, amount, status)
       values (?, ?, ?, ?, '2026-11-01', 10, 'confirmed')`,
      [id, householdId, userId, marketId],
    );
    return id;
  };

  const marketOf = async (billId: string): Promise<string> =>
    (
      (await sql('select market_id from bills where id = ?', [billId])) as [
        { market_id: string },
      ]
    )[0].market_id;

  const isDeleted = async (marketId: string): Promise<boolean> =>
    (
      (await sql(
        'select deleted_at is not null as deleted from markets where id = ?',
        [marketId],
      )) as [{ deleted: boolean }]
    )[0].deleted;

  it('moves the bills of case duplicates to the oldest market', async () => {
    const { userId, householdId } = await setup();
    const oldest = await market(householdId, 'Lidl', '2026-01-01');
    const newer = await market(householdId, 'LIDL', '2026-02-01');
    const newest = await market(householdId, 'lidl', '2026-03-01');
    const billOfNewer = await bill(householdId, userId, newer);
    const billOfNewest = await bill(householdId, userId, newest);

    await runMigration();

    expect(await marketOf(billOfNewer)).toBe(oldest);
    expect(await marketOf(billOfNewest)).toBe(oldest);
    expect(await isDeleted(oldest)).toBe(false);
    expect(await isDeleted(newer)).toBe(true);
    expect(await isDeleted(newest)).toBe(true);
  });

  it('leaves deleted markets and other households alone', async () => {
    const { userId, householdId } = await setup();
    const other = await setup();
    const live = await market(householdId, 'Metro', '2026-02-01');
    const deleted = await market(householdId, 'metro', '2026-01-01', true);
    const foreign = await market(other.householdId, 'METRO', '2026-01-01');
    const billOfDeleted = await bill(householdId, userId, deleted);

    await runMigration();

    expect(await isDeleted(live)).toBe(false);
    expect(await isDeleted(foreign)).toBe(false);
    expect(await marketOf(billOfDeleted)).toBe(deleted);
  });

  it('builds the unique index', async () => {
    const { householdId } = await setup();
    await market(householdId, 'Kaufland', '2026-01-01');
    await market(householdId, 'kaufland', '2026-02-01');

    await runMigration();

    await expect(market(householdId, 'KAUFLAND', '2026-03-01')).rejects.toThrow(
      /markets_household_id_lower_name_unique/,
    );
  });
});
