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
  ])('no longer has the write-only %s', async (name) => {
    expect((await indexDefs()).has(name)).toBe(false);
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

  it('findOrCreateMarket uses markets_household_id_index', async () => {
    const p = await plan(
      `select m0.* from markets m0
        where m0.name ilike 'Lidl' and m0.household_id = '${hid}'
          and m0.deleted_at is null limit 1`,
    );
    expect(p).toContain('markets_household_id_index');
  });
});
