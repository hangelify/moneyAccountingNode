import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MikroORM, RequestContext } from '@mikro-orm/core';
import { createTestApp, registerUser, TestUser } from './utils/app';
import { Category } from '../src/entities/category.entity';
import { SubCategory } from '../src/entities/sub-category.entity';
import { BillCrudService } from '../src/modules/bill/bill-crud.service';
import type {
  BillDetailResponseDto,
  DraftListResponseDto,
} from '../src/modules/bill/dto/bill-detail-response.dto';

// Every bill line in a response carries its own category (HAN-94), read from
// the line's category_id: with a sub-category, without one, or none at all.
describe('Bill line category in responses (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;
  let userId: string;
  let dairy: { categoryId: string; subId: string };

  const http = (method: 'get' | 'post', path: string) =>
    request(app.getHttpServer())
      [method](`/households/${user.householdId}/bills${path}`)
      .set('Authorization', `Bearer ${user.accessToken}`);

  const sql = (
    query: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> =>
    app.get(MikroORM).em.getConnection().execute(query, params, 'all');

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

  /**
   * A bill with three lines, all of the dairy sub-category, then reshaped in
   * SQL: the API cannot yet save a line with only a category (HAN-95).
   */
  async function billOfThreeStates(): Promise<{
    billId: string;
    full: string;
    categoryOnly: string;
    none: string;
  }> {
    const res = await http('post', '')
      .send({
        bill_date: '2026-05-07',
        total_amount: 3,
        items: [1, 2, 3].map(() => ({
          sub_category_id: dairy.subId,
          product_count: 1,
          amount: 1,
        })),
      })
      .expect(201);
    const bill = res.body as BillDetailResponseDto;
    const [full, categoryOnly, none] = bill.items.map((i) => i.id);
    await sql(
      `update bill_sub_categories set sub_category_id = null where id = ?`,
      [categoryOnly],
    );
    await sql(
      `update bill_sub_categories set sub_category_id = null, category_id = null where id = ?`,
      [none],
    );
    return { billId: bill.id, full, categoryOnly, none };
  }

  const categoryOf = (items: BillDetailResponseDto['items'], id: string) =>
    items.find((i) => i.id === id)?.category;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    user = await registerUser(app, 'line-category-resp');
    [{ id: userId }] = (await sql(`select id from users where email = ?`, [
      user.email,
    ])) as { id: string }[];
    dairy = await seedSub('Dairy HAN94');
  });

  it('POST /bills answers each line with its category', async () => {
    const res = await http('post', '')
      .send({
        bill_date: '2026-05-07',
        total_amount: 1,
        items: [{ sub_category_id: dairy.subId, product_count: 1, amount: 1 }],
      })
      .expect(201);

    expect((res.body as BillDetailResponseDto).items[0].category).toEqual({
      id: dairy.categoryId,
      name: 'Dairy HAN94',
    });
  });

  it('GET /bills/:id gives the line category with, without and lacking a sub-category', async () => {
    const { billId, full, categoryOnly, none } = await billOfThreeStates();

    const res = await http('get', `/${billId}`).expect(200);
    const items = (res.body as BillDetailResponseDto).items;

    const dairyRef = { id: dairy.categoryId, name: 'Dairy HAN94' };
    expect(categoryOf(items, full)).toEqual(dairyRef);
    expect(items.find((i) => i.id === full)?.sub_category).toEqual({
      id: dairy.subId,
      name: 'Dairy HAN94 sub',
      category_name: 'Dairy HAN94',
    });
    expect(categoryOf(items, categoryOnly)).toEqual(dairyRef);
    expect(items.find((i) => i.id === categoryOnly)?.sub_category).toBeNull();
    expect(categoryOf(items, none)).toBeNull();
  });

  it('GET /bills/:id keeps the name of a soft-deleted category', async () => {
    const { billId, categoryOnly } = await billOfThreeStates();
    await sql(`update categories set deleted_at = now() where id = ?`, [
      dairy.categoryId,
    ]);

    const res = await http('get', `/${billId}`).expect(200);

    expect(
      categoryOf((res.body as BillDetailResponseDto).items, categoryOnly),
    ).toEqual({ id: dairy.categoryId, name: 'Dairy HAN94' });
  });

  it('GET /bills/drafts gives each draft line its category', async () => {
    const { id: draftId } = await RequestContext.create(
      app.get(MikroORM).em,
      () =>
        app
          .get(BillCrudService)
          .createDraftFromParsed(user.householdId, userId, {
            draft_id: '',
            market_name: 'Shop',
            bill_date: '2026-05-07',
            currency: 'EUR',
            total_amount: 2,
            fiscal_register_id: null,
            fiscal_receipt_number: null,
            purchase_time: null,
            items: [dairy.subId, null].map((id, i) => ({
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

    const res = await http('get', '/drafts').expect(200);
    const draft = (res.body as DraftListResponseDto).data.find(
      (d) => d.id === draftId,
    )!;

    expect(draft.items.map((i) => i.category).sort()).toEqual(
      [{ id: dairy.categoryId, name: 'Dairy HAN94' }, null].sort(),
    );
  });
});
