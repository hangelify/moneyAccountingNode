import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Category } from '../../entities/category.entity';
import { PlaningHorizon } from '../../entities/planing-horizon.entity';
import {
  addCalendarDays,
  chisinauToday,
} from '../../common/utils/calendar-date';
import { CategoryService } from './category.service';

jest.setTimeout(30_000);

// The quick-entry form offers the categories the household used lately
// first (HAN-48).
describe('recently used categories (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  let householdId: string;
  let otherHouseholdId: string;
  const today = chisinauToday();
  const daysAgo = (n: number) => addCalendarDays(today, -n);

  const sql = (query: string, params: unknown[] = []) =>
    orm.em.getConnection().execute(query, params);

  async function household(name: string) {
    const id = randomUUID();
    await sql(
      `insert into households (id, name, created_by, currency) values (?, ?, ?, 'EUR')`,
      [id, name, userId],
    );
    return id;
  }
  async function category(hid: string, name: string, deleted = false) {
    const id = randomUUID();
    await sql(
      `insert into categories (id, name, household_id, deleted_at) values (?, ?, ?, ?)`,
      [id, name, hid, deleted ? new Date() : null],
    );
    return id;
  }
  async function subCategory(
    categoryId: string,
    name: string,
    deleted = false,
  ) {
    const id = randomUUID();
    await sql(
      `insert into sub_categories (id, name, category_id, deleted_at) values (?, ?, ?, ?)`,
      [id, name, categoryId, deleted ? new Date() : null],
    );
    return id;
  }
  /** A one-line bill on `day` for the category (and sub-category). */
  async function spend(
    hid: string,
    day: string,
    categoryId: string,
    subId: string | null = null,
    opts: { status?: string; deleted?: boolean } = {},
  ) {
    const billId = randomUUID();
    await sql(
      `insert into bills (id, household_id, bill_date, amount, status, currency, deleted_at)
       values (?, ?, ?, 1, ?, 'EUR', ?)`,
      [
        billId,
        hid,
        day,
        opts.status ?? 'confirmed',
        opts.deleted ? new Date() : null,
      ],
    );
    await sql(
      `insert into bill_sub_categories (bill_id, category_id, sub_category_id, raw_name, amount)
       values (?, ?, ?, 'x', 1)`,
      [billId, categoryId, subId],
    );
  }

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
    userId = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Recent', ?, 'x')`,
      [userId, `recent-${userId}@example.com`],
    );
    householdId = await household('Recent');
    otherHouseholdId = await household('Recent other');
  });

  beforeEach(async () => {
    for (const hid of [householdId, otherHouseholdId]) {
      await sql(
        `delete from bill_sub_categories where bill_id in (select id from bills where household_id = ?)`,
        [hid],
      );
      await sql('delete from bills where household_id = ?', [hid]);
      await sql(
        `delete from sub_categories where category_id in (select id from categories where household_id = ?)`,
        [hid],
      );
      await sql('delete from categories where household_id = ?', [hid]);
    }
  });

  afterAll(async () => {
    if (!orm) return;
    for (const hid of [householdId, otherHouseholdId]) {
      await sql(
        `delete from bill_sub_categories where bill_id in (select id from bills where household_id = ?)`,
        [hid],
      );
      await sql('delete from bills where household_id = ?', [hid]);
      await sql(
        `delete from sub_categories where category_id in (select id from categories where household_id = ?)`,
        [hid],
      );
      await sql('delete from categories where household_id = ?', [hid]);
      await sql('delete from households where id = ?', [hid]);
    }
    await sql('delete from users where id = ?', [userId]);
    await orm.close(true);
  });

  function service() {
    const fork = orm.em.fork();
    return new CategoryService(
      fork.getRepository(Category),
      fork.getRepository(PlaningHorizon),
      fork,
    );
  }

  it('lists category and sub-category pairs, newest use first', async () => {
    const food = await category(householdId, 'Food');
    const bread = await subCategory(food, 'Bread');
    const fun = await category(householdId, 'Fun');
    await spend(householdId, daysAgo(10), food, bread);
    await spend(householdId, daysAgo(3), food, bread);
    await spend(householdId, daysAgo(5), food);
    await spend(householdId, daysAgo(1), fun);

    const recent = await service().getRecentCategories(householdId, 10);

    expect(recent).toEqual([
      {
        category: { id: fun, name: 'Fun' },
        sub_category: null,
        last_used_at: daysAgo(1),
      },
      {
        category: { id: food, name: 'Food' },
        sub_category: { id: bread, name: 'Bread' },
        last_used_at: daysAgo(3),
      },
      {
        category: { id: food, name: 'Food' },
        sub_category: null,
        last_used_at: daysAgo(5),
      },
    ]);
  });

  it('stops at the limit', async () => {
    for (let i = 0; i < 3; i++) {
      await spend(
        householdId,
        daysAgo(i),
        await category(householdId, `C${i}`),
      );
    }

    const recent = await service().getRecentCategories(householdId, 2);

    expect(recent.map((r) => r.category.name)).toEqual(['C0', 'C1']);
  });

  it('skips deleted categories and sub-categories', async () => {
    const gone = await category(householdId, 'Gone', true);
    const food = await category(householdId, 'Food');
    const goneSub = await subCategory(food, 'Gone sub', true);
    await spend(householdId, daysAgo(1), gone);
    await spend(householdId, daysAgo(1), food, goneSub);

    expect(await service().getRecentCategories(householdId, 10)).toEqual([]);
  });

  it('counts only confirmed, live bills of the last 90 days', async () => {
    const food = await category(householdId, 'Food');
    await spend(householdId, daysAgo(1), food, null, { status: 'draft' });
    await spend(householdId, daysAgo(1), food, null, { deleted: true });
    await spend(householdId, daysAgo(91), food);
    expect(await service().getRecentCategories(householdId, 10)).toEqual([]);

    await spend(householdId, daysAgo(90), food);
    expect(
      (await service().getRecentCategories(householdId, 10)).map(
        (r) => r.last_used_at,
      ),
    ).toEqual([daysAgo(90)]);
  });

  it("ignores another household's bills", async () => {
    await spend(
      otherHouseholdId,
      daysAgo(1),
      await category(otherHouseholdId, 'Theirs'),
    );

    expect(await service().getRecentCategories(householdId, 10)).toEqual([]);
  });
});
