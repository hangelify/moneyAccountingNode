import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../src/mikro-orm.config';
import { LEGACY_ROWS_GUARD_SQL } from '../src/migrations/Migration20261115120000_ReplaceBudgetsWithCategoryLimits';

// HAN-24 replaces budgets and planning horizons with category_limits. Each
// test runs in a transaction that is rolled back, so the shared test schema
// is never migrated here; the up/down cycle is checked by the migration CLI.
describe('ReplaceBudgetsWithCategoryLimits migration (PostgreSQL)', () => {
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

  type Row = Record<string, unknown>;
  const sql = (query: string, params: unknown[] = []): Promise<Row[]> =>
    orm.em.getConnection().execute<Row[]>(query, params, 'all', trx);

  beforeEach(async () => {
    trx = await orm.em.getConnection().begin();
  });

  afterEach(async () => {
    await orm.em.getConnection().rollback(trx);
  });

  /** Runs `query` in a savepoint and returns the error it fails with. */
  const failure = async (
    query: string,
    params: unknown[] = [],
  ): Promise<{ code?: string; message: string }> => {
    await sql('savepoint expect_failure');
    try {
      await sql(query, params);
    } catch (err) {
      await sql('rollback to savepoint expect_failure');
      return err as { code?: string; message: string };
    }
    throw new Error(`expected to fail: ${query}`);
  };

  describe('category_limits', () => {
    const setup = async (): Promise<{
      userId: string;
      householdId: string;
      categoryId: string;
    }> => {
      const userId = randomUUID();
      const householdId = randomUUID();
      const categoryId = randomUUID();
      await sql(
        `insert into users (id, first_name, email, password) values (?, 'L24', ?, 'x')`,
        [userId, `l24-${userId}@example.com`],
      );
      await sql(
        `insert into households (id, name, created_by, currency) values (?, 'L24', ?, 'EUR')`,
        [householdId, userId],
      );
      await sql(
        `insert into categories (id, name, household_id) values (?, 'Food', ?)`,
        [categoryId, householdId],
      );
      return { userId, householdId, categoryId };
    };

    const insertLimit = `insert into category_limits
      (household_id, category_id, period_type, amount, currency, effective_from, effective_to, created_by_id)
      values (?, ?, 'MONTHLY', ?, 'EUR', ?, ?, ?)`;

    it('exists with both checks and the partial unique index', async () => {
      const checks = await sql(
        `select conname from pg_constraint
         where conrelid = 'category_limits'::regclass and contype = 'c'
         order by conname`,
      );
      expect(checks.map((r) => String(r['conname']))).toEqual([
        'category_limits_amount_positive',
        'category_limits_effective_range',
      ]);

      const [index] = await sql(
        `select indexdef from pg_indexes
         where tablename = 'category_limits'
           and indexname = 'category_limits_category_open_unique'`,
      );
      expect(index?.['indexdef']).toMatch(
        /UNIQUE INDEX .* \(category_id\) WHERE \(effective_to IS NULL\)/,
      );

      const lookup = await sql(
        `select 1 from pg_indexes
         where tablename = 'category_limits'
           and indexname = 'category_limits_household_category_from_index'`,
      );
      expect(lookup).toHaveLength(1);
    });

    it('allows one open version per category', async () => {
      const { userId, householdId, categoryId } = await setup();
      await sql(insertLimit, [
        householdId,
        categoryId,
        100,
        '2026-01-01',
        '2026-02-01',
        userId,
      ]);
      await sql(insertLimit, [
        householdId,
        categoryId,
        100,
        '2026-02-01',
        null,
        userId,
      ]);

      const err = await failure(insertLimit, [
        householdId,
        categoryId,
        200,
        '2026-03-01',
        null,
        userId,
      ]);
      expect(err.code).toBe('23505');
    });

    it('rejects a zero amount', async () => {
      const { userId, householdId, categoryId } = await setup();
      const err = await failure(insertLimit, [
        householdId,
        categoryId,
        0,
        '2026-01-01',
        null,
        userId,
      ]);
      expect(err.code).toBe('23514');
    });

    it('rejects an empty effective range', async () => {
      const { userId, householdId, categoryId } = await setup();
      const err = await failure(insertLimit, [
        householdId,
        categoryId,
        100,
        '2026-01-01',
        '2026-01-01',
        userId,
      ]);
      expect(err.code).toBe('23514');
    });
  });

  describe('legacy rows guard', () => {
    // Temporary tables shadow the unqualified names, so the guard sees them
    // and the shared schema stays as it is.
    beforeEach(async () => {
      await sql(`create temp table budgets (id uuid primary key)`);
      await sql(`create temp table planing_horizons (id uuid primary key)`);
      await sql(
        `create temp table planing_horizon_categories (planing_horizon_id uuid, category_id uuid)`,
      );
    });

    it('passes when the legacy tables are empty', async () => {
      await expect(sql(LEGACY_ROWS_GUARD_SQL)).resolves.toBeDefined();
    });

    it.each([
      ['budgets', `insert into budgets (id) values (?)`],
      ['planing_horizons', `insert into planing_horizons (id) values (?)`],
      [
        'planing_horizon_categories',
        `insert into planing_horizon_categories (planing_horizon_id) values (?)`,
      ],
    ])('refuses to drop a non-empty %s', async (_table, insert) => {
      await sql(insert, [randomUUID()]);

      const err = await failure(LEGACY_ROWS_GUARD_SQL);
      expect(err.message).toContain('export them before HAN-24 migration');
    });
  });
});
