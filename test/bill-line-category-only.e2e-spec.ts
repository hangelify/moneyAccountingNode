import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MikroORM, RequestContext } from '@mikro-orm/core';
import { createTestApp, registerUser, TestUser } from './utils/app';
import { Category } from '../src/entities/category.entity';
import { SubCategory } from '../src/entities/sub-category.entity';
import { BillCrudService } from '../src/modules/bill/bill-crud.service';
import type { BillDetailResponseDto } from '../src/modules/bill/dto/bill-detail-response.dto';

// A bill line can name a category without a sub-category on create, confirm
// and update; with both, the sub-category must be of that category (HAN-95).
type Seeded = { name: string; categoryId: string; subId: string };

describe('Bill line with a category and no sub-category (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;
  let other: TestUser;
  let userId: string;
  let seeded = 0;
  let dairy: Seeded;
  let bakery: Seeded;

  const http = (method: 'get' | 'put' | 'post', path: string) =>
    request(app.getHttpServer())
      [method](`/households/${user.householdId}/bills${path}`)
      .set('Authorization', `Bearer ${user.accessToken}`);

  const sql = (
    query: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> =>
    app.get(MikroORM).em.getConnection().execute(query, params, 'all');

  /** line id → its sub_category_id, category_id, confidence and raw_name. */
  const lines = async (billId: string) =>
    new Map(
      (
        await sql(
          `select id, sub_category_id, category_id, category_confidence, raw_name
             from bill_sub_categories where bill_id = ?`,
          [billId],
        )
      ).map((r) => [
        r.id as string,
        {
          sub_category_id: (r.sub_category_id as string | null) ?? null,
          category_id: (r.category_id as string | null) ?? null,
          category_confidence: r.category_confidence as string | null,
          raw_name: r.raw_name as string,
        },
      ]),
    );

  async function seedSub(
    name: string,
    householdId = user.householdId,
  ): Promise<Seeded> {
    const em = app.get(MikroORM).em.fork();
    const category = em.create(Category, {
      name,
      household: householdId,
    } as never);
    const sub = em.create(SubCategory, {
      name: `${name} sub`,
      category,
    } as never);
    await em.flush();
    return { name, categoryId: category.id, subId: sub.id };
  }

  // Called as the photo ingest does, outside an HTTP request.
  const draftFromParsed = (subIds: string[]) =>
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
          sub_category: { id, name: 'x', category_name: 'x' },
          category: null,
          category_confidence: 0.9,
        })),
      }),
    );

  const createBill = (items: object[]) =>
    http('post', '').send({
      bill_date: '2026-05-07',
      total_amount: items.length,
      items: items.map((it) => ({ product_count: 1, amount: 1, ...it })),
    });

  beforeAll(async () => {
    app = await createTestApp();
    // Registered once: sign-up is rate limited.
    user = await registerUser(app, 'line-category-only');
    other = await registerUser(app, 'line-category-only-other');
    [{ id: userId }] = (await sql(`select id from users where email = ?`, [
      user.email,
    ])) as { id: string }[];
  });

  afterAll(async () => {
    await app.close();
  });

  // Fresh categories per test: one test deletes its category.
  beforeEach(async () => {
    seeded += 1;
    dairy = await seedSub(`Dairy HAN95 ${seeded}`);
    bakery = await seedSub(`Bakery HAN95 ${seeded}`);
  });

  describe('POST /bills', () => {
    it('saves a line with a category alone, named after the category', async () => {
      const res = await createBill([{ category_id: dairy.categoryId }]).expect(
        201,
      );
      const bill = res.body as BillDetailResponseDto;

      expect(bill.items[0]).toMatchObject({
        raw_name: dairy.name,
        sub_category: null,
        category: { id: dairy.categoryId, name: dairy.name },
      });
      expect([...(await lines(bill.id)).values()]).toEqual([
        expect.objectContaining({
          sub_category_id: null,
          category_id: dairy.categoryId,
        }),
      ]);
    });

    it('accepts a sub-category together with its own category', async () => {
      const res = await createBill([
        { sub_category_id: dairy.subId, category_id: dairy.categoryId },
      ]).expect(201);
      const bill = res.body as BillDetailResponseDto;

      expect(bill.items[0]).toMatchObject({
        raw_name: `${dairy.name} sub`,
        sub_category: { id: dairy.subId },
        category: { id: dairy.categoryId },
      });
    });

    it('keeps a sub-category-only line as before', async () => {
      const res = await createBill([{ sub_category_id: bakery.subId }]).expect(
        201,
      );
      expect((res.body as BillDetailResponseDto).items[0]).toMatchObject({
        raw_name: `${bakery.name} sub`,
        category: { id: bakery.categoryId },
      });
    });

    it('rejects a line with neither', async () => {
      const res = await createBill([{}]).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'Send sub_category_id, category_id or both',
      );
    });

    it('rejects a sub-category of another category', async () => {
      const res = await createBill([
        { sub_category_id: dairy.subId, category_id: bakery.categoryId },
      ]).expect(400);
      expect(JSON.stringify(res.body)).toContain('is not in Category');
    });

    it('rejects a category of another household', async () => {
      const foreign = await seedSub(
        `Foreign HAN95 ${seeded}`,
        other.householdId,
      );

      const res = await createBill([
        { category_id: foreign.categoryId },
      ]).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        `Category with ID ${foreign.categoryId} not found`,
      );
    });

    it('rejects a deleted category', async () => {
      await sql(`update categories set deleted_at = now() where id = ?`, [
        dairy.categoryId,
      ]);

      const res = await createBill([{ category_id: dairy.categoryId }]).expect(
        400,
      );
      expect(JSON.stringify(res.body)).toContain(
        `Category with ID ${dairy.categoryId} not found`,
      );
    });
  });

  it('confirming a draft moves a line from its sub-category to a category alone', async () => {
    const { id: billId } = await draftFromParsed([dairy.subId, dairy.subId]);
    const [first, second] = [...(await lines(billId)).keys()];

    const res = await http('post', `/${billId}/confirm`)
      .send({
        bill_date: '2026-05-07',
        total_amount: 3,
        items: [
          {
            id: first,
            category_id: bakery.categoryId,
            product_count: 1,
            amount: 1,
          },
          // A new line named after its category.
          { category_id: dairy.categoryId, product_count: 1, amount: 1 },
          // Unchanged: keeps the model's confidence.
          {
            id: second,
            sub_category_id: dairy.subId,
            product_count: 1,
            amount: 1,
          },
        ],
      })
      .expect(200);
    const items = (res.body as BillDetailResponseDto).items;
    const added = items.find((i) => i.id !== first && i.id !== second)!;

    const saved = await lines(billId);
    expect(saved.get(first)).toEqual({
      sub_category_id: null,
      category_id: bakery.categoryId,
      category_confidence: null,
      raw_name: 'line 0',
    });
    expect(saved.get(added.id)).toMatchObject({
      sub_category_id: null,
      category_id: dairy.categoryId,
      raw_name: dairy.name,
    });
    expect(saved.get(second)).toMatchObject({
      sub_category_id: dairy.subId,
      category_id: dairy.categoryId,
    });
    expect(saved.get(second)!.category_confidence).not.toBeNull();
    expect(items.find((i) => i.id === first)).toMatchObject({
      sub_category: null,
      category: { id: bakery.categoryId, name: bakery.name },
    });
  });

  it('confirming rejects a sub-category of another category and keeps the draft', async () => {
    const { id: billId } = await draftFromParsed([dairy.subId]);
    const before = await lines(billId);
    const [lineId] = [...before.keys()];

    await http('post', `/${billId}/confirm`)
      .send({
        bill_date: '2026-05-07',
        total_amount: 1,
        items: [
          {
            id: lineId,
            sub_category_id: dairy.subId,
            category_id: bakery.categoryId,
            product_count: 1,
            amount: 1,
          },
        ],
      })
      .expect(400);
    expect(await lines(billId)).toEqual(before);
  });

  it('PUT /bills/:id with a category alone drops the sub-category, even of that category', async () => {
    const created = await createBill([{ sub_category_id: dairy.subId }]).expect(
      201,
    );
    const bill = created.body as BillDetailResponseDto;

    const updated = await http('put', `/${bill.id}`)
      .send({
        items: [
          {
            id: bill.items[0].id,
            category_id: dairy.categoryId,
            product_count: 1,
            amount: 1,
          },
        ],
      })
      .expect(200);

    expect((updated.body as BillDetailResponseDto).items[0]).toMatchObject({
      raw_name: `${dairy.name} sub`,
      sub_category: null,
      category: { id: dairy.categoryId },
    });
    expect((await lines(bill.id)).get(bill.items[0].id)).toMatchObject({
      sub_category_id: null,
      category_id: dairy.categoryId,
    });
  });

  it('PUT /bills/:id rejects a category of another household', async () => {
    const foreign = await seedSub(`Foreign HAN95 ${seeded}`, other.householdId);
    const created = await createBill([{ sub_category_id: dairy.subId }]).expect(
      201,
    );
    const bill = created.body as BillDetailResponseDto;

    await http('put', `/${bill.id}`)
      .send({
        items: [
          {
            id: bill.items[0].id,
            category_id: foreign.categoryId,
            product_count: 1,
            amount: 1,
          },
        ],
      })
      .expect(400);
  });
});
