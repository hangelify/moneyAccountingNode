import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { createTestApp, registerUser, TestUser } from './utils/app';
import { Category } from '../src/entities/category.entity';
import { SubCategory } from '../src/entities/sub-category.entity';
import { EXCHANGE_RATE_PROVIDER } from '../src/modules/exchange-rate/exchange-rate.provider';
import { StubProvider } from '../src/modules/exchange-rate/testing/stub-exchange-rate.provider';
import type { ManualBatchResponseDto } from '../src/modules/bill/dto/manual-batch-response.dto';
import type { RecentCategoryDto } from '../src/modules/category/dto/recent-categories.dto';

// The quick-entry form over HTTP: guards, the global validation pipe, the
// exception filter and the 201/200 split of POST manual-batch (HAN-48).
describe('POST /households/:hid/bills/manual-batch (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;
  let categoryId: string;
  let subCategoryId: string;

  const post = (body: unknown, as: TestUser = user, hid = user.householdId) =>
    request(app.getHttpServer())
      .post(`/households/${hid}/bills/manual-batch`)
      .set('Authorization', `Bearer ${as.accessToken}`)
      .send(body as object);
  const row = (over: Record<string, unknown> = {}) => ({
    bill_date: '2026-11-05',
    amount: 2.5,
    category_id: categoryId,
    ...over,
  });

  beforeAll(async () => {
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_PROVIDER)
          .useValue(new StubProvider('TEST-MANUAL')),
    });
  });

  beforeEach(async () => {
    user = await registerUser(app, 'manual-batch');
    const em = app.get(MikroORM).em.fork();
    const category = em.create(Category, {
      name: 'Food',
      household: user.householdId,
    } as never);
    const sub = em.create(SubCategory, { name: 'Bread', category } as never);
    await em.flush();
    categoryId = category.id;
    subCategoryId = sub.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers 201 with one bill per row, then 200 to a resend', async () => {
    const body = {
      client_batch_id: randomUUID(),
      rows: [
        row({ note: ' coffee ', market_name: 'Kiosk' }),
        row({ sub_category_id: subCategoryId, amount: 4 }),
      ],
    };

    const first = (await post(body).expect(201)).body as ManualBatchResponseDto;
    expect(first.client_batch_id).toBe(body.client_batch_id);
    expect(first.bills).toHaveLength(2);
    expect(first.bills[0]).toMatchObject({
      source: 'manual',
      status: 'confirmed',
      total_amount: 2.5,
      market: { name: 'Kiosk' },
    });

    const again = (await post(body).expect(200)).body as ManualBatchResponseDto;
    expect(again.bills.map((b) => b.id)).toEqual(first.bills.map((b) => b.id));

    const list = await request(app.getHttpServer())
      .get(`/households/${user.householdId}/bills?limit=100`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect((list.body as { data: unknown[] }).data).toHaveLength(2);
  });

  it('answers a bad body with the validation pipe, naming the row', async () => {
    const res = await post({
      client_batch_id: randomUUID(),
      rows: [row(), row({ amount: 0, payment: 'cash' })],
    }).expect(400);

    const messages = (res.body as { message: string[] }).message;
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('rows.1.amount') as string,
        expect.stringContaining('rows.1.property payment') as string,
      ]),
    );
  });

  it('answers rows naming foreign data with errors by row', async () => {
    const res = await post({
      client_batch_id: randomUUID(),
      rows: [row(), row({ category_id: randomUUID() })],
    }).expect(400);

    expect(res.body).toEqual({
      statusCode: 400,
      message: 'Some rows are invalid',
      errors: [
        { index: 1, field: 'category_id', message: 'Category not found' },
      ],
    });
  });

  it("refuses another household's batch", async () => {
    const stranger = await registerUser(app, 'manual-batch-stranger');

    await post(
      { client_batch_id: randomUUID(), rows: [row()] },
      stranger,
      user.householdId,
    ).expect(403);
  });

  it('offers the saved categories as recent', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await post({
      client_batch_id: randomUUID(),
      rows: [row({ bill_date: today, sub_category_id: subCategoryId })],
    }).expect(201);

    const res = await request(app.getHttpServer())
      .get(`/households/${user.householdId}/categories/recent?limit=5`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(res.body as RecentCategoryDto[]).toEqual([
      {
        category: { id: categoryId, name: 'Food' },
        sub_category: { id: subCategoryId, name: 'Bread' },
        last_used_at: today,
      },
    ]);
  });

  it('rejects a recent limit out of range', async () => {
    await request(app.getHttpServer())
      .get(`/households/${user.householdId}/categories/recent?limit=51`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(400);
  });

  it('documents both 400 shapes', async () => {
    const doc = (
      await request(app.getHttpServer()).get('/api-json').expect(200)
    ).body as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };

    const bad = doc.paths['/households/{hid}/bills/manual-batch'].post
      .responses['400'] as {
      content: {
        'application/json': { schema: { oneOf: { $ref: string }[] } };
      };
    };

    expect(
      bad.content['application/json'].schema.oneOf.map((s) => s.$ref),
    ).toEqual([
      '#/components/schemas/ValidationErrorResponseDto',
      '#/components/schemas/ManualBatchErrorResponseDto',
    ]);
  });

  it('needs a signed-in user', async () => {
    await request(app.getHttpServer())
      .post(`/households/${user.householdId}/bills/manual-batch`)
      .send({ client_batch_id: randomUUID(), rows: [row()] })
      .expect(401);
  });
});
