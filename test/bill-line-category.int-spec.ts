import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../src/mikro-orm.config';
import { Migration20261109130000_AddBillLineCategory } from '../src/migrations/Migration20261109130000_AddBillLineCategory';

// A bill line's category used to be derived only through its sub-category.
// The migration adds bill_sub_categories.category_id and fills it from the
// sub-category. Each test runs in a transaction that is rolled back; the
// migration's down() runs first so the lines exist without the column.
describe('AddBillLineCategory migration (PostgreSQL)', () => {
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

  const run = async (direction: 'up' | 'down') => {
    const migration = new Migration20261109130000_AddBillLineCategory(
      orm.em.getDriver(),
      orm.config,
    );
    migration[direction]();
    for (const query of migration.getQueries()) {
      await sql(query as string);
    }
  };

  beforeEach(async () => {
    trx = await conn().begin();
    await run('down');
  });

  afterEach(async () => {
    await conn().rollback(trx);
  });

  const setup = async () => {
    const userId = randomUUID();
    const householdId = randomUUID();
    const billId = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'HAN91', ?, 'x')`,
      [userId, `han91-${userId}@example.com`],
    );
    await sql(
      `insert into households (id, name, created_by, currency) values (?, 'HAN91', ?, 'EUR')`,
      [householdId, userId],
    );
    await sql(
      `insert into bills (id, household_id, created_by_user_id, bill_date, amount, status)
       values (?, ?, ?, '2026-11-01', 10, 'confirmed')`,
      [billId, householdId, userId],
    );
    return { householdId, billId };
  };

  const category = async (householdId: string, name: string) => {
    const id = randomUUID();
    await sql(
      `insert into categories (id, name, household_id) values (?, ?, ?)`,
      [id, name, householdId],
    );
    return id;
  };

  const subCategory = async (
    categoryId: string,
    name: string,
    deleted = false,
  ) => {
    const id = randomUUID();
    await sql(
      `insert into sub_categories (id, name, category_id, deleted_at) values (?, ?, ?, ${deleted ? 'now()' : 'null'})`,
      [id, name, categoryId],
    );
    return id;
  };

  const line = async (billId: string, subCategoryId: string | null) => {
    const id = randomUUID();
    await sql(
      `insert into bill_sub_categories (id, bill_id, sub_category_id, raw_name, amount) values (?, ?, ?, 'item', 1)`,
      [id, billId, subCategoryId],
    );
    return id;
  };

  const categoryOf = async (lineId: string): Promise<string | null> =>
    (
      (await sql('select category_id from bill_sub_categories where id = ?', [
        lineId,
      ])) as [{ category_id: string | null }]
    )[0].category_id;

  it("fills a line's category from its sub-category", async () => {
    const { householdId, billId } = await setup();
    const dairy = await category(householdId, 'Dairy');
    const meat = await category(householdId, 'Meat');
    const cheese = await line(billId, await subCategory(dairy, 'Cheese'));
    const pork = await line(billId, await subCategory(meat, 'Pork'));

    await run('up');

    expect(await categoryOf(cheese)).toBe(dairy);
    expect(await categoryOf(pork)).toBe(meat);
  });

  it('leaves a line without a sub-category uncategorized', async () => {
    const { billId } = await setup();
    const uncategorized = await line(billId, null);

    await run('up');

    expect(await categoryOf(uncategorized)).toBeNull();
  });

  it('fills lines whose sub-category is soft deleted', async () => {
    const { householdId, billId } = await setup();
    const dairy = await category(householdId, 'Dairy');
    const old = await line(billId, await subCategory(dairy, 'Kefir', true));

    await run('up');

    expect(await categoryOf(old)).toBe(dairy);
  });

  it('rejects a category that does not exist', async () => {
    const { billId } = await setup();
    const lineId = await line(billId, null);

    await run('up');

    await expect(
      sql('update bill_sub_categories set category_id = ? where id = ?', [
        randomUUID(),
        lineId,
      ]),
    ).rejects.toThrow(/bill_sub_categories_category_id_foreign/);
  });
});
