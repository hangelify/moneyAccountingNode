import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../src/mikro-orm.config';
import { Migration20261011160000_DedupePersonalHouseholds } from '../src/migrations/Migration20261011160000_DedupePersonalHouseholds';

// Migration20260603130000 gave users who already had a "Personal" household
// from registration a second one and moved their rows into it. The cleanup
// deletes only empty duplicates: owner as the sole member, no rows, no invites.
// Each test runs in a transaction that is rolled back.
describe('DedupePersonalHouseholds migration (PostgreSQL)', () => {
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
  });

  afterEach(async () => {
    await conn().rollback(trx);
  });

  const runMigration = async () => {
    const migration = new Migration20261011160000_DedupePersonalHouseholds(
      orm.em.getDriver(),
      orm.config,
    );
    migration.up();
    for (const query of migration.getQueries()) {
      await sql(query as string);
    }
  };

  const createUser = async (): Promise<string> => {
    const id = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'P20', ?, 'x')`,
      [id, `p20-${id}@example.com`],
    );
    return id;
  };

  const createHousehold = async (
    ownerId: string,
    createdAt: string,
    name = 'Personal',
  ): Promise<string> => {
    const id = randomUUID();
    await sql(
      `insert into households (id, name, created_by, created_at) values (?, ?, ?, ?)`,
      [id, name, ownerId, createdAt],
    );
    await sql(
      `insert into household_members (household_id, user_id, role) values (?, ?, 'owner')`,
      [id, ownerId],
    );
    return id;
  };

  const addBudget = (householdId: string) =>
    sql(`insert into budgets (name, household_id) values (?, ?)`, [
      `budget-${randomUUID()}`,
      householdId,
    ]);

  const remaining = async (ids: string[]): Promise<string[]> => {
    const rows = await sql(
      `select id from households where id = any(?::uuid[]) order by created_at`,
      [`{${ids.join(',')}}`],
    );
    return rows.map((r) => r.id as string);
  };

  it('deletes the empty registration household when the migrated one holds the data', async () => {
    const user = await createUser();
    const registered = await createHousehold(user, '2026-05-01');
    const migrated = await createHousehold(user, '2026-06-03');
    await addBudget(migrated);

    await runMigration();

    expect(await remaining([registered, migrated])).toEqual([migrated]);
  });

  it.each([
    [
      'bills',
      `insert into bills (amount, bill_date, household_id) values (1, '2026-01-01', ?)`,
    ],
    ['budgets', `insert into budgets (name, household_id) values ('b', ?)`],
    [
      'categories',
      `insert into categories (name, household_id) values ('c', ?)`,
    ],
    ['markets', `insert into markets (name, household_id) values ('m', ?)`],
  ])('keeps both households when each has %s', async (_table, insert) => {
    const user = await createUser();
    const first = await createHousehold(user, '2026-05-01');
    const second = await createHousehold(user, '2026-06-03');
    await sql(insert, [first]);
    await addBudget(second);

    await runMigration();

    expect(await remaining([first, second])).toEqual([first, second]);
  });

  it('keeps the oldest household when every duplicate is empty', async () => {
    const user = await createUser();
    const oldest = await createHousehold(user, '2026-05-01');
    const newer = await createHousehold(user, '2026-06-03');
    const newest = await createHousehold(user, '2026-06-04');

    await runMigration();

    expect(await remaining([oldest, newer, newest])).toEqual([oldest]);
  });

  it('keeps an empty duplicate that has another member', async () => {
    const user = await createUser();
    const other = await createUser();
    const shared = await createHousehold(user, '2026-05-01');
    const migrated = await createHousehold(user, '2026-06-03');
    await addBudget(migrated);
    await sql(
      `insert into household_members (household_id, user_id, role) values (?, ?, 'member')`,
      [shared, other],
    );

    await runMigration();

    expect(await remaining([shared, migrated])).toEqual([shared, migrated]);
  });

  it('keeps an empty duplicate that has an invite', async () => {
    const user = await createUser();
    const invited = await createHousehold(user, '2026-05-01');
    const migrated = await createHousehold(user, '2026-06-03');
    await addBudget(migrated);
    await sql(
      `insert into household_invites (household_id, invitee_email, invited_by, token_hash, expires_at)
       values (?, 'guest@example.com', ?, ?, now() + interval '1 day')`,
      [invited, user, randomUUID().replace(/-/g, '')],
    );

    await runMigration();

    expect(await remaining([invited, migrated])).toEqual([invited, migrated]);
  });

  it('leaves single and non-Personal households alone', async () => {
    const user = await createUser();
    const personal = await createHousehold(user, '2026-05-01');
    const family = await createHousehold(user, '2026-06-03', 'Family');

    await runMigration();

    expect(await remaining([personal, family])).toEqual([personal, family]);
  });

  it('counts soft-deleted rows as data', async () => {
    const user = await createUser();
    const registered = await createHousehold(user, '2026-05-01');
    const migrated = await createHousehold(user, '2026-06-03');
    await addBudget(migrated);
    await sql(
      `insert into bills (amount, bill_date, household_id, deleted_at) values (1, '2026-01-01', ?, now())`,
      [registered],
    );

    await runMigration();

    expect(await remaining([registered, migrated])).toEqual([
      registered,
      migrated,
    ]);
  });

  it('ignores soft-deleted households', async () => {
    const user = await createUser();
    const live = await createHousehold(user, '2026-06-03');
    const deleted = await createHousehold(user, '2026-05-01');
    await addBudget(deleted);
    await sql(`update households set deleted_at = now() where id = ?`, [
      deleted,
    ]);

    await runMigration();

    expect(await remaining([deleted, live])).toEqual([deleted, live]);
  });

  it('keeps Personal households created after the ownership migration ran', async () => {
    const user = await createUser();
    const migrated = await createHousehold(user, '2026-06-03');
    await addBudget(migrated);
    const later = await createHousehold(user, '2999-01-01');

    await runMigration();

    expect(await remaining([migrated, later])).toEqual([migrated, later]);
  });

  it('handles several owners independently', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const aliceOld = await createHousehold(alice, '2026-05-01');
    const aliceNew = await createHousehold(alice, '2026-06-03');
    const bobOld = await createHousehold(bob, '2026-05-02');
    const bobNew = await createHousehold(bob, '2026-06-03');
    await addBudget(aliceNew);
    await addBudget(bobOld);

    await runMigration();

    expect(await remaining([aliceOld, aliceNew, bobOld, bobNew])).toEqual([
      bobOld,
      aliceNew,
    ]);
  });

  it('is idempotent', async () => {
    const user = await createUser();
    const registered = await createHousehold(user, '2026-05-01');
    const migrated = await createHousehold(user, '2026-06-03');
    await addBudget(migrated);

    await runMigration();
    await runMigration();

    expect(await remaining([registered, migrated])).toEqual([migrated]);
  });
});
