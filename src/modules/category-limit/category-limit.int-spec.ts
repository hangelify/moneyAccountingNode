import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { LimitPeriodType } from '../../types/limit-period-type.enum';
// Through the barrel: Task 5 and 6 consume exactly this API.
import {
  CategoryLimitDto,
  CategoryLimitService,
  LimitChange,
  writeCategoryLimit,
} from '.';

jest.setTimeout(30_000);

interface LimitRow {
  id: string;
  period_type: LimitPeriodType;
  amount: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  created_by_id: string | null;
  updated_at: Date;
}

const NOW = new Date('2026-11-15T10:00:00Z');
const at = (day: string): Date => new Date(`${day}T10:00:00Z`);
const { MONTHLY, QUARTERLY } = LimitPeriodType;

// Versioned category limits (HAN-24): every write locks the category row,
// plans the change and applies it in one transaction.
describe('category limits (PostgreSQL)', () => {
  let orm: MikroORM;
  let service: CategoryLimitService;
  const userId = randomUUID();
  // A (EUR) is the household under test; B (EUR) another one; C (EUR)
  // changes its currency.
  const a = randomUUID();
  const b = randomUUID();
  const c = randomUUID();
  const households = [a, b, c];

  const sql = <T = unknown>(
    query: string,
    params: unknown[] = [],
  ): Promise<T> => orm.em.getConnection().execute(query, params) as Promise<T>;

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
    service = new CategoryLimitService(orm.em);
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Limits', ?, 'x')`,
      [userId, `limits-${userId}@example.com`],
    );
    for (const id of households) {
      await sql(
        `insert into households (id, name, created_by, currency) values (?, 'Limits', ?, 'EUR')`,
        [id, userId],
      );
    }
  });

  afterAll(async () => {
    await sql(
      'delete from category_limits where household_id in (?, ?, ?)',
      households,
    );
    await sql(
      'delete from categories where household_id in (?, ?, ?)',
      households,
    );
    await sql('delete from households where id in (?, ?, ?)', households);
    await sql('delete from users where id = ?', [userId]);
    await orm.close(true);
  });

  /** A fresh live category of `household` (default A); returns its id. */
  async function category(
    household = a,
    opts: { name?: string; deleted?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into categories (id, name, household_id, deleted_at) values (?, ?, ?, ?)`,
      [
        id,
        opts.name ?? `Limits ${id}`,
        household,
        opts.deleted ? new Date() : null,
      ],
    );
    return id;
  }

  /** The category's versions, oldest first. */
  const versionsOf = (categoryId: string): Promise<LimitRow[]> =>
    sql<LimitRow[]>(
      `select id, period_type, amount::float8 as amount, currency,
              to_char(effective_from, 'YYYY-MM-DD') as effective_from,
              to_char(effective_to, 'YYYY-MM-DD') as effective_to,
              created_by_id, updated_at
       from category_limits where category_id = ? order by effective_from`,
      [categoryId],
    );

  const intervals = async (categoryId: string): Promise<unknown[][]> =>
    (await versionsOf(categoryId)).map((v) => [
      v.period_type,
      v.amount,
      v.effective_from,
      v.effective_to,
    ]);

  /** Exactly one open row and no two overlapping versions, checked in SQL. */
  async function expectConsistent(categoryId: string): Promise<void> {
    const [open] = await sql<{ n: number }[]>(
      `select count(*)::int as n from category_limits
       where category_id = ? and effective_to is null`,
      [categoryId],
    );
    expect(open?.n).toBe(1);
    const [overlaps] = await sql<{ n: number }[]>(
      `select count(*)::int as n from category_limits x
       join category_limits y on y.category_id = x.category_id and y.id < x.id
       where x.category_id = ?
         and daterange(x.effective_from, x.effective_to)
             && daterange(y.effective_from, y.effective_to)`,
      [categoryId],
    );
    expect(overlaps?.n).toBe(0);
  }

  const monthly = (
    amount: number,
  ): { period_type: LimitPeriodType; amount: number } => ({
    period_type: MONTHLY,
    amount,
  });
  const create = (
    categoryId: string,
    amount = 300,
    now = NOW,
    household = a,
  ): Promise<CategoryLimitDto> =>
    service.create(
      household,
      userId,
      { category_id: categoryId, ...monthly(amount) },
      now,
    );

  it('create → version from 2026-11-01 in household currency (EUR)', async () => {
    const cat = await category(a, { name: 'Food limits' });

    const dto = await create(cat);

    const { id, ...rest } = dto;
    expect(rest).toEqual({
      category_id: cat,
      category_name: 'Food limits',
      category_archived: false,
      period_type: MONTHLY,
      amount: 300,
      currency: 'EUR',
      effective_from: '2026-11-01',
      effective_to: null,
    });
    const [row] = await versionsOf(cat);
    expect(row).toMatchObject({ id, created_by_id: userId });
  });

  it('second create while open → ConflictException', async () => {
    const cat = await category();
    await create(cat);

    // Even with the same body.
    await expect(create(cat)).rejects.toBeInstanceOf(ConflictException);
    expect(await versionsOf(cat)).toHaveLength(1);
  });

  it('update in a later month closes the old version', async () => {
    const cat = await category();
    await create(cat, 300, at('2026-10-10'));

    await service.update(a, userId, cat, monthly(350), NOW);

    expect(await intervals(cat)).toEqual([
      [MONTHLY, 300, '2026-10-01', '2026-11-01'],
      [MONTHLY, 350, '2026-11-01', null],
    ]);
    const history = (await service.list(a, true, NOW)).filter(
      (x) => x.category_id === cat,
    );
    expect(history.map((x) => [x.effective_from, x.effective_to])).toEqual([
      ['2026-10-01', '2026-11-01'],
      ['2026-11-01', null],
    ]);
  });

  it('update twice in a month keeps one version per start', async () => {
    const cat = await category();
    await create(cat, 300, at('2026-10-10'));

    await service.update(a, userId, cat, monthly(350), at('2026-11-02'));
    const last = await service.update(a, userId, cat, monthly(400), NOW);

    expect(await intervals(cat)).toEqual([
      [MONTHLY, 300, '2026-10-01', '2026-11-01'],
      [MONTHLY, 400, '2026-11-01', null],
    ]);
    expect(last).toMatchObject({ amount: 400, effective_from: '2026-11-01' });
  });

  it('month → quarter rewrites October', async () => {
    const cat = await category();
    await create(cat, 300, at('2026-09-10'));
    await service.update(a, userId, cat, monthly(350), at('2026-11-05'));

    const dto = await service.update(
      a,
      userId,
      cat,
      { period_type: QUARTERLY, amount: 1000 },
      NOW,
    );

    expect(await intervals(cat)).toEqual([
      [MONTHLY, 300, '2026-09-01', '2026-10-01'],
      [QUARTERLY, 1000, '2026-10-01', null],
    ]);
    expect(dto).toMatchObject({
      period_type: QUARTERLY,
      effective_from: '2026-10-01',
      effective_to: null,
    });
  });

  it('update with same values is a no-op', async () => {
    const cat = await category();
    const created = await create(cat);
    const [before] = await versionsOf(cat);

    const dto = await service.update(a, userId, cat, monthly(300), NOW);

    expect(dto).toEqual(created);
    const after = await versionsOf(cat);
    expect(after).toHaveLength(1);
    expect(after[0]?.updated_at).toEqual(before?.updated_at);
  });

  it('remove sets effective_to to next period start; list still shows it until then', async () => {
    const cat = await category();
    const created = await create(cat);

    const removed = await service.remove(a, userId, cat, at('2026-11-20'));

    expect(removed).toMatchObject({
      id: created.id,
      effective_from: '2026-11-01',
      effective_to: '2026-12-01',
    });
    const inForce = (now: Date): Promise<CategoryLimitDto[]> =>
      service
        .list(a, false, now)
        .then((xs) => xs.filter((x) => x.category_id === cat));
    expect(await inForce(at('2026-11-30'))).toEqual([removed]);
    expect(await inForce(at('2026-12-01'))).toEqual([]);
  });

  it('create after remove in the same month → one open version from 2026-11-01', async () => {
    const cat = await category();
    await create(cat);
    await service.remove(a, userId, cat, NOW);

    const dto = await create(cat, 500, at('2026-11-20'));

    expect(dto).toMatchObject({ amount: 500, effective_from: '2026-11-01' });
    expect(await intervals(cat)).toEqual([[MONTHLY, 500, '2026-11-01', null]]);
  });

  it('update or remove without an open limit → NotFoundException', async () => {
    const none = await category();
    await expect(
      service.update(a, userId, none, monthly(300), NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(a, userId, none, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await versionsOf(none)).toEqual([]);

    // A closing version is not open.
    const closing = await category();
    await create(closing);
    await service.remove(a, userId, closing, NOW);
    const before = await versionsOf(closing);
    await expect(
      service.update(a, userId, closing, monthly(400), NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.remove(a, userId, closing, NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await versionsOf(closing)).toEqual(before);
  });

  it('category of another household / deleted category → NotFoundException, nothing written', async () => {
    const foreign = await category(b);
    const deleted = await category(a, { deleted: true });

    for (const cat of [foreign, deleted]) {
      await expect(create(cat)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.update(a, userId, cat, monthly(300), NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.remove(a, userId, cat, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await versionsOf(cat)).toEqual([]);
    }
  });

  it('list shows the limit of an archived category as archived', async () => {
    const cat = await category();
    await create(cat);
    await sql('update categories set deleted_at = now() where id = ?', [cat]);

    const [dto] = (await service.list(a, false, NOW)).filter(
      (x) => x.category_id === cat,
    );

    expect(dto?.category_archived).toBe(true);
  });

  it('household currency changed: next update writes MDL, old version stays EUR', async () => {
    const cat = await category(c);
    await create(cat, 300, at('2026-10-10'), c);
    await sql(`update households set currency = 'MDL' where id = ?`, [c]);

    const dto = await service.update(c, userId, cat, monthly(5000), NOW);

    expect(dto.currency).toBe('MDL');
    expect((await versionsOf(cat)).map((v) => v.currency)).toEqual([
      'EUR',
      'MDL',
    ]);
  });

  it('parallel create → one fulfilled, one ConflictException, one open row', async () => {
    const cat = await category();

    const results = await Promise.allSettled([
      create(cat, 300),
      create(cat, 400),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictException);
    await expectConsistent(cat);
    expect(await versionsOf(cat)).toHaveLength(1);
  });

  it('parallel update → exactly one open row, no overlapping versions', async () => {
    const cat = await category();
    await create(cat, 300, at('2026-10-10'));

    const results = await Promise.allSettled([
      service.update(a, userId, cat, monthly(400), NOW),
      service.update(
        a,
        userId,
        cat,
        { period_type: QUARTERLY, amount: 900 },
        NOW,
      ),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    await expectConsistent(cat);
    const open = (await versionsOf(cat)).find((v) => v.effective_to === null);
    expect([
      [MONTHLY, 400],
      [QUARTERLY, 900],
    ]).toContainEqual([open?.period_type, open?.amount]);
  });

  it('writeCategoryLimit joins the caller transaction: a rollback undoes it', async () => {
    const cat = await category();
    await create(cat);
    const remove: LimitChange = { kind: 'remove' };

    await expect(
      orm.em.fork().transactional(async (tx) => {
        const closed = await writeCategoryLimit(tx, a, cat, remove, {
          userId: null,
          today: '2026-11-15',
          requireOpen: true,
        });
        expect(closed?.effective_to).toBe('2026-12-01');
        throw new Error('caller fails after the write');
      }),
    ).rejects.toThrow('caller fails after the write');

    expect(await intervals(cat)).toEqual([[MONTHLY, 300, '2026-11-01', null]]);
  });
});
