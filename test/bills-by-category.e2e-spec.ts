import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, registerUser, TestUser } from './utils/app';
import type { LimitReportDto } from '../src/modules/category-limit';
import { todayIsoDate } from '../src/common/utils/calendar-date';

interface ByCategoryBody {
  data: { id: string; total_amount: number; category_amount: number | null }[];
  meta: { total: number };
  category: { id: string; name: string; archived: boolean };
  category_total: number;
  household_currency: string;
  unconverted_lines: number;
}

const dayBefore = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// HAN-149 through the real app: guards, ValidationPipe, route order against
// GET /bills/:id, Swagger, and the total against the limits report.
describe('GET /households/:hid/bills/by-category/:categoryId (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;
  let stranger: TestUser;
  let food = '';
  let home = '';
  let mixedBill = '';

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const auth = (u: TestUser): string => `Bearer ${u.accessToken}`;
  const byCategory = (
    categoryId: string,
    query = '',
    as: TestUser = user,
    hid = user.householdId,
  ): request.Test =>
    http()
      .get(`/households/${hid}/bills/by-category/${categoryId}?${query}`)
      .set('Authorization', auth(as));

  const category = async (u: TestUser, name: string): Promise<string> => {
    const res = await http()
      .post(`/households/${u.householdId}/categories`)
      .set('Authorization', auth(u))
      .send({ name })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  const createBill = async (lines: [string, number][]): Promise<string> => {
    const res = await http()
      .post(`/households/${user.householdId}/bills`)
      .set('Authorization', auth(user))
      .send({
        bill_date: todayIsoDate(),
        currency: 'EUR',
        total_amount: lines.reduce((s, [, a]) => s + a, 0),
        items: lines.map(([category_id, amount]) => ({
          category_id,
          product_count: 1,
          amount,
        })),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'by-category');
    stranger = await registerUser(app, 'by-category-stranger');
    food = await category(user, 'Food HAN-149');
    home = await category(user, 'Home HAN-149');
    mixedBill = await createBill([
      [food, 30],
      [home, 50],
    ]);
    await createBill([[food, 12.34]]);
    await createBill([[home, 5]]);
  });

  afterAll(async () => {
    await app.close();
  });

  it("lists the category's bills with contribution, total and category", async () => {
    const res = await byCategory(food).expect(200);
    const body = res.body as ByCategoryBody;
    expect(body.meta.total).toBe(2);
    expect(body.data.find((b) => b.id === mixedBill)).toMatchObject({
      total_amount: 80,
      category_amount: 30,
    });
    expect(body).toMatchObject({
      category: { id: food, name: 'Food HAN-149', archived: false },
      category_total: 42.34,
      household_currency: 'EUR',
      unconverted_lines: 0,
    });
  });

  it("the total equals the limits report's spent for the period", async () => {
    await http()
      .post(`/households/${user.householdId}/category-limits`)
      .set('Authorization', auth(user))
      .send({ category_id: food, period_type: 'MONTHLY', amount: 100 })
      .expect(201);
    const report = (
      await http()
        .get(
          `/households/${user.householdId}/category-limits/report?period_type=MONTHLY`,
        )
        .set('Authorization', auth(user))
        .expect(200)
    ).body as LimitReportDto;
    const row = report.categories.find((c) => c.category_id === food);
    const res = await byCategory(
      food,
      `date_from=${report.start}&date_to=${dayBefore(report.end)}`,
    ).expect(200);
    expect((res.body as ByCategoryBody).category_total).toBe(row?.spent);
  });

  it('rejects a non-UUID category id with 400', async () => {
    await byCategory('not-a-uuid').expect(400);
  });

  it('rejects date_from after date_to with 400', async () => {
    await byCategory(food, 'date_from=2026-03-02&date_to=2026-03-01').expect(
      400,
    );
  });

  it("answers 404 for another household's category or an unknown one", async () => {
    const foreign = await category(stranger, 'Foreign HAN-149');
    await byCategory(foreign).expect(404);
    await byCategory(randomUUID()).expect(404);
  });

  it("forbids another household's list", async () => {
    await byCategory(food, '', stranger).expect(403);
  });

  it('requires a token', async () => {
    await http()
      .get(`/households/${user.householdId}/bills/by-category/${food}`)
      .expect(401);
  });

  it('leaves GET /bills/:id working', async () => {
    const res = await http()
      .get(`/households/${user.householdId}/bills/${mixedBill}`)
      .set('Authorization', auth(user))
      .expect(200);
    expect((res.body as { id: string }).id).toBe(mixedBill);
  });

  it('is documented in Swagger', async () => {
    const res = await http().get('/api-json').expect(200);
    const doc = res.body as {
      paths: Record<string, { get?: { parameters: { name: string }[] } }>;
      components: { schemas: Record<string, unknown> };
    };
    const op =
      doc.paths['/households/{hid}/bills/by-category/{categoryId}']?.get;
    expect(op?.parameters.map((p) => p.name)).toEqual(
      expect.arrayContaining(['categoryId', 'date_from', 'date_to', 'page']),
    );
    expect(doc.components.schemas).toHaveProperty('BillsByCategoryResponseDto');
  });
});
