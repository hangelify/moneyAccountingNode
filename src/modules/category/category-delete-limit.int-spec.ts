import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { NotFoundException } from '@nestjs/common';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Category } from '../../entities/category.entity';
import { CategoryService } from './category.service';
import { Currency } from '../../types/currency.enum';

jest.setTimeout(30_000);

const NOW = new Date('2026-11-15T10:00:00Z');

interface LimitRow {
  effective_from: string;
  effective_to: string | null;
}

// Deleting a category lets its open limit run to the end of its period.
describe('deleteCategory and the category limit (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  let householdId: string;

  const sql = <T = unknown>(q: string, params: unknown[] = []): Promise<T> =>
    orm.em.getConnection().execute(q, params) as Promise<T>;

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
    userId = randomUUID();
    householdId = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password) values (?, ?, ?, ?)`,
      [userId, 'DelLimit', `del-limit-${userId}@example.com`, 'x'],
    );
    await sql(
      `insert into households (id, name, currency, created_by) values (?, ?, ?, ?)`,
      [householdId, 'Delete limit', Currency.EUR, userId],
    );
  });

  afterAll(async () => {
    await sql('delete from category_limits where household_id = ?', [
      householdId,
    ]);
    await sql(
      'delete from sub_categories where category_id in (select id from categories where household_id = ?)',
      [householdId],
    );
    await sql('delete from categories where household_id = ?', [householdId]);
    await sql('delete from households where id = ?', [householdId]);
    await sql('delete from users where id = ?', [userId]);
    await orm.close(true);
  });

  const service = (): CategoryService =>
    new CategoryService(orm.em.fork().getRepository(Category), orm.em.fork());

  async function category(): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into categories (id, name, household_id) values (?, ?, ?)`,
      [id, `Del ${id}`, householdId],
    );
    return id;
  }

  const addLimit = (
    categoryId: string,
    from: string,
    to: string | null,
  ): Promise<unknown> =>
    sql(
      `insert into category_limits
         (id, household_id, category_id, period_type, amount, currency, effective_from, effective_to)
       values (?, ?, ?, 'MONTHLY', 100, 'EUR', ?, ?)`,
      [randomUUID(), householdId, categoryId, from, to],
    );

  const limitsOf = (categoryId: string): Promise<LimitRow[]> =>
    sql<LimitRow[]>(
      `select to_char(effective_from, 'YYYY-MM-DD') as effective_from,
              to_char(effective_to, 'YYYY-MM-DD') as effective_to
       from category_limits where category_id = ? order by effective_from`,
      [categoryId],
    );

  it('closes an open MONTHLY limit at the next month start', async () => {
    const id = await category();
    await addLimit(id, '2026-11-01', null);

    await service().deleteCategory(id, householdId, NOW);

    expect(await limitsOf(id)).toEqual([
      { effective_from: '2026-11-01', effective_to: '2026-12-01' },
    ]);
    // November's balance is not carried to a limit recreated later (HAN-25).
    expect(
      await sql(
        `select period_type, to_char(period_start, 'YYYY-MM-DD') as period_start
         from category_limit_carry_stops where category_id = ?`,
        [id],
      ),
    ).toEqual([{ period_type: 'MONTHLY', period_start: '2026-11-01' }]);
    const c = await orm.em.fork().findOneOrFail(Category, id);
    expect(c.deleted_at).toBeInstanceOf(Date);
  });

  it('leaves an already closing limit as it is', async () => {
    const id = await category();
    await addLimit(id, '2026-11-01', '2026-12-01');

    await service().deleteCategory(id, householdId, NOW);

    expect(await limitsOf(id)).toEqual([
      { effective_from: '2026-11-01', effective_to: '2026-12-01' },
    ]);
  });

  it('deletes a category without a limit', async () => {
    const id = await category();

    await service().deleteCategory(id, householdId, NOW);

    expect(await limitsOf(id)).toEqual([]);
    const c = await orm.em.fork().findOneOrFail(Category, id);
    expect(c.deleted_at).toBeInstanceOf(Date);
  });

  it('still returns 404 for an unknown category', async () => {
    await expect(
      service().deleteCategory(randomUUID(), householdId, NOW),
    ).rejects.toThrow(NotFoundException);
  });
});
