import { MikroORM } from '@mikro-orm/core';
import { createMikroOrmConfig } from '../src/mikro-orm.config';

// Indexes behind the household-scoped reads (parse-photo, drafts, markets,
// dashboard), the foreign keys to users, and the write-only indexes dropped
// in their place. The tables are empty here, so the planner tests run with
// enable_seqscan off: they prove an index is usable for the query's shape
// (e.g. that a partial index's predicate is implied), not that it is cheaper.
describe('database indexes (PostgreSQL)', () => {
  let orm: MikroORM;
  const hid = '00000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
  });

  afterAll(async () => {
    await orm.close();
  });

  const indexDefs = async (): Promise<Map<string, string>> => {
    const rows = await (orm.em
      .getConnection()
      .execute(
        `select indexname, indexdef from pg_indexes where schemaname = 'public'`,
      ) as Promise<Array<{ indexname: string; indexdef: string }>>);
    return new Map(rows.map((r) => [r.indexname, r.indexdef]));
  };

  const plan = async (sql: string): Promise<string> => {
    const conn = orm.em.getConnection();
    return conn.transactional(async (trx) => {
      await conn.execute('set local enable_seqscan = off', [], 'run', trx);
      const rows = await (conn.execute(
        `explain ${sql}`,
        [],
        'all',
        trx,
      ) as Promise<Array<{ 'QUERY PLAN': string }>>);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
  };

  it.each([
    [
      'categories_household_id_index',
      'ON public.categories USING btree (household_id)',
    ],
    [
      'bills_household_status_date_index',
      'ON public.bills USING btree (household_id, status, bill_date DESC) WHERE (deleted_at IS NULL)',
    ],
    [
      'bills_market_id_index',
      'ON public.bills USING btree (market_id) WHERE (deleted_at IS NULL)',
    ],
    [
      'markets_household_id_index',
      'ON public.markets USING btree (household_id) WHERE (deleted_at IS NULL)',
    ],
    [
      'household_invites_household_id_index',
      'ON public.household_invites USING btree (household_id)',
    ],
    [
      'ai_requests_user_id_created_at_index',
      'ON public.ai_requests USING btree (user_id, created_at)',
    ],
    [
      'bills_created_by_user_id_index',
      'ON public.bills USING btree (created_by_user_id)',
    ],
    [
      'households_created_by_index',
      'ON public.households USING btree (created_by)',
    ],
    [
      'household_invites_invited_by_index',
      'ON public.household_invites USING btree (invited_by)',
    ],
    [
      'users_email_lower_unique',
      'CREATE UNIQUE INDEX users_email_lower_unique ON public.users USING btree (lower((email)::text))',
    ],
    [
      'ai_requests_pending_index',
      `ON public.ai_requests USING btree (created_at) WHERE (status = 'PENDING'::ai_request_status_enum)`,
    ],
    [
      'bills_household_drafts_created_index',
      `ON public.bills USING btree (household_id, created_at DESC, id DESC) WHERE ((status = 'draft'::bill_status_enum) AND (deleted_at IS NULL))`,
    ],
    [
      'bills_household_image_sha256_draft_unique',
      `CREATE UNIQUE INDEX bills_household_image_sha256_draft_unique ON public.bills USING btree (household_id, image_sha256) WHERE ((status = 'draft'::bill_status_enum) AND (deleted_at IS NULL) AND (image_sha256 IS NOT NULL))`,
    ],
    [
      'bills_ai_request_id_index',
      'ON public.bills USING btree (ai_request_id)',
    ],
    [
      'ai_requests_household_id_index',
      'ON public.ai_requests USING btree (household_id)',
    ],
    [
      'ai_requests_unscrubbed_created_index',
      'ON public.ai_requests USING btree (created_at) WHERE (prompt IS NOT NULL)',
    ],
    [
      'refresh_tokens_expires_at_index',
      'ON public.refresh_tokens USING btree (expires_at)',
    ],
    [
      'sessions_absolute_expires_at_index',
      'ON public.sessions USING btree (absolute_expires_at)',
    ],
    [
      'bill_sub_categories_sub_category_id_partial_index',
      'ON public.bill_sub_categories USING btree (sub_category_id) WHERE (sub_category_id IS NOT NULL)',
    ],
    [
      'bill_sub_categories_bill_id_index',
      'ON public.bill_sub_categories USING btree (bill_id)',
    ],
  ])('has %s', async (name, def) => {
    expect((await indexDefs()).get(name)).toContain(def);
  });

  it.each([
    'ai_requests_status_index',
    'ai_requests_task_name_index',
    'ai_request_attempts_provider_name_index',
    'sessions_is_active_index',
    'bills_bill_date_index',
    'users_email_unique',
    // One row per receipt line: a bill may list a sub-category many times.
    'bill_sub_categories_bill_sub_category_unique',
  ])('no longer has the write-only %s', async (name) => {
    expect((await indexDefs()).has(name)).toBe(false);
  });

  it('retention: the AI audit scrub uses ai_requests_unscrubbed_created_index', async () => {
    // Shape of RetentionService.scrubAiAudit's batch selection.
    const p = await plan(
      `select id from ai_requests
        where prompt is not null and created_at < now() and status <> 'PENDING'
        order by created_at limit 100`,
    );
    expect(p).toContain('ai_requests_unscrubbed_created_index');
  });

  it('parse-photo: household sub-categories use categories_household_id_index without a categories.deleted_at filter', async () => {
    // Shape of BillPhotoService.parseAndCategorize's sub-category load.
    const p = await plan(
      `select s0.* from sub_categories s0
         left join categories c1 on s0.category_id = c1.id
        where s0.deleted_at is null and c1.household_id = '${hid}'`,
    );
    expect(p).toContain('categories_household_id_index');
    expect(p).not.toMatch(/Seq Scan on categories/);
  });

  it('listDrafts pages drafts newest first from bills_household_drafts_created_index', async () => {
    const p = await plan(
      `select b0.* from bills b0
        where b0.household_id = '${hid}' and b0.status = 'draft'
          and b0.deleted_at is null
        order by b0.created_at desc, b0.id desc limit 20`,
    );
    expect(p).toContain('bills_household_drafts_created_index');
    expect(p).not.toContain('Sort');
  });

  it('listDrafts counts drafts from bills_household_drafts_created_index', async () => {
    const p = await plan(
      `select count(*) from bills b0
        where b0.household_id = '${hid}' and b0.status = 'draft'
          and b0.deleted_at is null`,
    );
    expect(p).toContain('bills_household_drafts_created_index');
  });

  it('dashboard bills use bills_household_status_date_index', async () => {
    const p = await plan(
      `select b.id from bills b
        where b.household_id = '${hid}' and b.status = 'confirmed'
          and b.bill_date >= '2026-01-01' and b.bill_date < '2027-01-01'
          and b.deleted_at is null
        order by b.bill_date desc limit 50`,
    );
    expect(p).toContain('bills_household_status_date_index');
  });

  it('user lookup by email uses users_email_lower_unique', async () => {
    // Shape of AuthService's lookups: where lower(email) = ?
    const p = await plan(
      `select u0.* from users u0 where lower(u0.email) = 'user@x.com' limit 1`,
    );
    expect(p).toContain('users_email_lower_unique');
  });

  it('findOrCreate looks a market up by markets_household_id_lower_name_unique', async () => {
    const p = await plan(
      `select id from markets
        where household_id = '${hid}' and lower(name) = lower('Lidl')
          and deleted_at is null`,
    );
    expect(p).toContain('markets_household_id_lower_name_unique');
  });

  // Runs `fn` in a transaction with a fixture household and always rolls
  // back, so the shared test database stays empty.
  const inRolledBackTx = async (
    fn: (
      run: (sql: string, params?: unknown[]) => Promise<unknown>,
      householdId: string,
    ) => Promise<void>,
  ): Promise<void> => {
    const conn = orm.em.getConnection();
    const rollback = new Error('rollback');
    await conn
      .transactional(async (trx) => {
        const run = (sql: string, params: unknown[] = []) =>
          conn.execute(sql, params, 'all', trx) as Promise<unknown>;
        const [user] = (await run(
          `insert into users (first_name, email, password) values ('T', 'schema-test@x.com', 'x') returning id`,
        )) as Array<{ id: string }>;
        const [household] = (await run(
          `insert into households (name, currency, created_by) values ('H', 'EUR', ?) returning id`,
          [user.id],
        )) as Array<{ id: string }>;
        await fn(run, household.id);
        throw rollback;
      })
      .catch((e: unknown) => {
        if (e !== rollback) throw e;
      });
  };

  it('bills_parse_error_check ties failed status to an error code', async () => {
    await inRolledBackTx(async (run, householdId) => {
      const insert = (status: string, code: string | null) =>
        run(
          `insert into bills (household_id, amount, bill_date, status, parse_error_code)
           values (?, 0, '2026-11-02', ?, ?)`,
          [householdId, status, code],
        );
      // Each rejected insert needs its own savepoint to keep the tx usable.
      const rejects = async (status: string, code: string | null) => {
        await run('savepoint s');
        await expect(insert(status, code)).rejects.toThrow(
          /bills_parse_error_check/,
        );
        await run('rollback to savepoint s');
      };
      await rejects('failed', null);
      await rejects('draft', 'ai_failed');
      await expect(insert('failed', 'ai_failed')).resolves.toBeDefined();
    });
  });

  it('bill_batch_items is unique per batch and position', async () => {
    await inRolledBackTx(async (run, householdId) => {
      const [batch] = (await run(
        `insert into bill_batches (household_id, total) values (?, 2) returning id`,
        [householdId],
      )) as Array<{ id: string }>;
      const insert = (position: number) =>
        run(
          `insert into bill_batch_items (batch_id, position, image_key, image_sha256, status)
           values (?, ?, 'k', 'h', 'queued')`,
          [batch.id, position],
        );
      await insert(0);
      await insert(1);
      await run('savepoint s');
      await expect(insert(0)).rejects.toThrow(
        /bill_batch_items_batch_id_position_unique/,
      );
    });
  });
});
