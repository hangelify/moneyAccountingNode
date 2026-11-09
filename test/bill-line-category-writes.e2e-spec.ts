import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MikroORM, RequestContext } from '@mikro-orm/core';
import { createTestApp, registerUser, TestUser } from './utils/app';
import { Category } from '../src/entities/category.entity';
import { SubCategory } from '../src/entities/sub-category.entity';
import { BillCrudService } from '../src/modules/bill/bill-crud.service';
import type { BillDetailResponseDto } from '../src/modules/bill/dto/bill-detail-response.dto';

// A bill line keeps its own category_id (HAN-91). Every write of a line sets
// it to the category of the line's sub-category, or NULL without one, so the
// column never drifts from the sub-category (HAN-92).
describe('Bill line category_id on writes (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;
  let userId: string;
  let dairy: { categoryId: string; subId: string };
  let bakery: { categoryId: string; subId: string };

  const http = (method: 'get' | 'put' | 'post', path: string) =>
    request(app.getHttpServer())
      [method](`/households/${user.householdId}/bills${path}`)
      .set('Authorization', `Bearer ${user.accessToken}`);

  const sql = (
    query: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> =>
    app.get(MikroORM).em.getConnection().execute(query, params, 'all');

  /** line id → its category_id. */
  const lineCategories = async (billId: string) =>
    new Map(
      (
        await sql(
          `select id, category_id from bill_sub_categories where bill_id = ?`,
          [billId],
        )
      ).map((r) => [r.id as string, (r.category_id as string | null) ?? null]),
    );

  /** Lines of the bill whose category_id is not their sub-category's. */
  const drifted = async (billId: string) =>
    (
      await sql(
        `select bsc.id
           from bill_sub_categories bsc
           left join sub_categories sc on sc.id = bsc.sub_category_id
          where bsc.bill_id = ?
            and bsc.category_id is distinct from sc.category_id`,
        [billId],
      )
    ).length;

  async function seedSub(name: string) {
    const em = app.get(MikroORM).em.fork();
    const category = em.create(Category, {
      name,
      household: user.householdId,
    } as never);
    const sub = em.create(SubCategory, {
      name: `${name} sub`,
      category,
    } as never);
    await em.flush();
    return { categoryId: category.id, subId: sub.id };
  }

  // Called as the photo ingest does, outside an HTTP request.
  const draftFromParsed = (subIds: (string | null)[]) =>
    RequestContext.create(app.get(MikroORM).em, () =>
      app.get(BillCrudService).createDraftFromParsed(user.householdId, userId, {
        draft_id: '',
        market_name: 'Shop',
        bill_date: '2026-05-07',
        currency: 'EUR',
        total_amount: subIds.length,
        fiscal_register_id: null,
        fiscal_receipt_number: null,
        purchase_time: null,
        items: subIds.map((id, i) => ({
          name: `line ${i}`,
          quantity: 1,
          unit: null,
          weight_kg: null,
          price_per_kg: null,
          final_price: 1,
          sub_category: id ? { id, name: 'x', category_name: 'x' } : null,
          category: null,
          category_confidence: 0.9,
        })),
      }),
    );

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    user = await registerUser(app, 'line-category');
    [{ id: userId }] = (await sql(`select id from users where email = ?`, [
      user.email,
    ])) as { id: string }[];
    dairy = await seedSub('Dairy HAN92');
    bakery = await seedSub('Bakery HAN92');
  });

  it('POST /bills sets each line to its sub-category’s category', async () => {
    const res = await http('post', '')
      .send({
        bill_date: '2026-05-07',
        total_amount: 3,
        items: [
          { sub_category_id: dairy.subId, product_count: 1, amount: 1 },
          { sub_category_id: bakery.subId, product_count: 1, amount: 2 },
        ],
      })
      .expect(201);
    const billId = (res.body as BillDetailResponseDto).id;

    expect([...(await lineCategories(billId)).values()].sort()).toEqual(
      [dairy.categoryId, bakery.categoryId].sort(),
    );
    expect(await drifted(billId)).toBe(0);
  });

  it('a draft from a parsed photo gets the category of each sub-category', async () => {
    const { id: billId } = await draftFromParsed([dairy.subId, null]);

    expect([...(await lineCategories(billId)).values()].sort()).toEqual(
      [dairy.categoryId, null].sort(),
    );
    expect(await drifted(billId)).toBe(0);
  });

  it('a draft line naming an unknown sub-category is saved without one', async () => {
    const other = await registerUser(app, 'line-category-other');
    const em = app.get(MikroORM).em.fork();
    const foreign = em.create(SubCategory, {
      name: 'foreign',
      category: em.create(Category, {
        name: 'Foreign HAN92',
        household: other.householdId,
      } as never),
    } as never);
    await em.flush();

    const { id: billId } = await draftFromParsed([foreign.id]);

    const rows = await sql(
      `select sub_category_id, category_id from bill_sub_categories where bill_id = ?`,
      [billId],
    );
    expect(rows).toEqual([{ sub_category_id: null, category_id: null }]);
  });

  it('confirming a draft with a changed and a removed sub-category keeps category_id in step', async () => {
    const { id: billId } = await draftFromParsed([dairy.subId, dairy.subId]);
    const [first, second] = [...(await lineCategories(billId)).keys()];

    await http('post', `/${billId}/confirm`)
      .send({
        bill_date: '2026-05-07',
        total_amount: 2,
        items: [
          {
            id: first,
            sub_category_id: bakery.subId,
            product_count: 1,
            amount: 1,
          },
          { id: second, raw_name: 'line 1', product_count: 1, amount: 1 },
        ],
      })
      .expect(200);

    const categories = await lineCategories(billId);
    expect(categories.get(first)).toBe(bakery.categoryId);
    expect(categories.get(second)).toBeNull();
    expect(await drifted(billId)).toBe(0);
  });

  it('PUT /bills/:id moving a line to another category and adding one updates category_id', async () => {
    const created = await http('post', '')
      .send({
        bill_date: '2026-05-07',
        total_amount: 1,
        items: [{ sub_category_id: dairy.subId, product_count: 1, amount: 1 }],
      })
      .expect(201);
    const bill = created.body as BillDetailResponseDto;

    const updated = await http('put', `/${bill.id}`)
      .send({
        items: [
          {
            id: bill.items[0].id,
            sub_category_id: bakery.subId,
            product_count: 1,
            amount: 1,
          },
          { sub_category_id: dairy.subId, product_count: 1, amount: 2 },
        ],
      })
      .expect(200);
    const items = (updated.body as BillDetailResponseDto).items;
    const added = items.find((i) => i.id !== bill.items[0].id)!;

    const categories = await lineCategories(bill.id);
    expect(categories.get(bill.items[0].id)).toBe(bakery.categoryId);
    expect(categories.get(added.id)).toBe(dairy.categoryId);
    expect(await drifted(bill.id)).toBe(0);
  });
});
