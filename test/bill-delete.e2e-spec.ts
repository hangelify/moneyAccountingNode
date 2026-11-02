import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import {
  createTestApp,
  registerUser,
  seedAiRequest,
  TestUser,
} from './utils/app';
import { Bill } from '../src/entities/bill.entity';
import { BillSubCategory } from '../src/entities/bill-sub-category.entity';
import { Category } from '../src/entities/category.entity';
import { SubCategory } from '../src/entities/sub-category.entity';
import { BillStatus } from '../src/types/bill-status.enum';
import { Currency } from '../src/types/currency.enum';
import { STORAGE_SERVICE } from '../src/modules/storage/storage.service';
import { EXCHANGE_RATE_PROVIDER } from '../src/modules/exchange-rate/exchange-rate.provider';
import { StubProvider } from '../src/modules/exchange-rate/testing/stub-exchange-rate.provider';
import type { BillListResponseDto } from '../src/modules/bill/dto/bill-list-response.dto';
import type { BillDashboardResponseDto } from '../src/modules/bill/dto/bill-dashboard.dto';
import type { SpendingBreakdownResponseDto } from '../src/modules/bill/dto/spending-breakdown.dto';
import type { DuplicateSuggestionsResponseDto } from '../src/modules/bill/dto/bill-duplicates.dto';

const DASHBOARD = 'dashboard?type=year&year=2026';
const BREAKDOWN =
  'dashboard/spending-breakdown?period=custom&from=2026-01-01&to=2026-12-31';

// DELETE /bills/:id is a soft delete for a bill of any status. Afterwards the
// bill is gone from every read: lists, detail, dashboard, spending breakdown,
// duplicate suggestions, and every call on its id answers 404.
describe('DELETE /households/:hid/bills/:id (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;
  let subCategoryId: string;

  const http = (method: 'get' | 'put' | 'post' | 'delete', path: string) =>
    request(app.getHttpServer())
      [method](`/households/${user.householdId}/bills${path}`)
      .set('Authorization', `Bearer ${user.accessToken}`);
  const del = (id: string) => http('delete', `/${id}`);

  const listIds = async (query = '') =>
    (
      (await http('get', `?limit=100${query}`).expect(200))
        .body as BillListResponseDto
    ).data.map((b) => b.id);
  const draftIds = async () =>
    (
      (await http('get', '/drafts?limit=100').expect(200)).body as {
        data: { id: string }[];
      }
    ).data.map((b) => b.id);
  const dashboard = async () => {
    const body = (await http('get', `/${DASHBOARD}`).expect(200))
      .body as BillDashboardResponseDto;
    const eur = body.by_currency.find((s) => s.currency === Currency.EUR);
    return {
      ids: body.bills.map((b) => b.id),
      total: (eur?.period_totals ?? []).reduce((sum, p) => sum + p.total, 0),
    };
  };
  const breakdownTotal = async () => {
    const body = (await http('get', `/${BREAKDOWN}`).expect(200))
      .body as SpendingBreakdownResponseDto;
    return (
      body.by_currency.find((s) => s.currency === Currency.EUR)?.total ?? 0
    );
  };
  const suggestionIds = async () =>
    (
      (await http('get', '/duplicate-suggestions').expect(200))
        .body as DuplicateSuggestionsResponseDto
    ).pairs.map((p) => [p.bill.id, p.other.id].sort());

  // Saves a bill of the user's household with one line of `amount`.
  async function seedBill(data: Record<string, unknown>): Promise<string> {
    const em = app.get(MikroORM).em.fork();
    const bill = em.create(Bill, {
      household: user.householdId,
      status: BillStatus.CONFIRMED,
      currency: Currency.EUR,
      ...data,
    } as never);
    em.create(BillSubCategory, {
      bill,
      sub_category: subCategoryId,
      raw_name: 'item',
      product_count: 1,
      amount: data.amount,
    } as never);
    await em.flush();
    return bill.id;
  }

  beforeAll(async () => {
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_PROVIDER)
          .useValue(new StubProvider('TEST-DEL'))
          .overrideProvider(STORAGE_SERVICE)
          .useValue({
            put: jest.fn(),
            exists: jest.fn(),
            getSignedUrl: jest.fn().mockResolvedValue('https://s3.test/r.jpg'),
          }),
    });
  });

  beforeEach(async () => {
    user = await registerUser(app, 'bill-delete');
    const em = app.get(MikroORM).em.fork();
    const category = em.create(Category, {
      name: 'Delete spec',
      household: user.householdId,
    } as never);
    const sub = em.create(SubCategory, {
      name: 'delete spec',
      category,
    } as never);
    await em.flush();
    subCategoryId = sub.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('removes a confirmed bill from lists, totals and duplicate suggestions', async () => {
    const kept = await seedBill({ bill_date: '2026-03-05', amount: 10 });
    const twin = await seedBill({ bill_date: '2026-03-07', amount: 7 });
    const gone = await seedBill({ bill_date: '2026-03-07', amount: 7 });

    expect(await listIds()).toEqual(expect.arrayContaining([gone]));
    expect(await dashboard()).toEqual({
      ids: expect.arrayContaining([gone]) as string[],
      total: 24,
    });
    expect(await breakdownTotal()).toBe(24);
    expect(await suggestionIds()).toEqual([[gone, twin].sort()]);

    await del(gone).expect(204);

    expect((await listIds()).sort()).toEqual([kept, twin].sort());
    expect(await dashboard()).toEqual({
      ids: expect.not.arrayContaining([gone]) as string[],
      total: 17,
    });
    expect(await breakdownTotal()).toBe(17);
    expect(await suggestionIds()).toEqual([]);
  });

  it('answers 404 on every call on a deleted bill', async () => {
    const gone = await seedBill({ bill_date: '2026-03-05', amount: 10 });
    const other = await seedBill({ bill_date: '2026-03-06', amount: 3 });
    await del(gone).expect(204);

    await http('get', `/${gone}`).expect(404);
    await http('put', `/${gone}`).send({}).expect(404);
    await del(gone).expect(404);
    await http('post', `/${gone}/mark-duplicate`)
      .send({ duplicate_of_id: other })
      .expect(404);
    // Nor can a live bill be linked to it.
    await http('post', `/${other}/mark-duplicate`)
      .send({ duplicate_of_id: gone })
      .expect(404);
  });

  it('discards a draft: gone from drafts, its photo and confirm', async () => {
    const aiRequestId = randomUUID();
    await seedAiRequest(app, aiRequestId);
    await app
      .get(MikroORM)
      .em.getConnection()
      .execute('update ai_requests set image_s3_keys = ? where id = ?', [
        JSON.stringify(['receipts/r.jpg']),
        aiRequestId,
      ]);
    const draft = await seedBill({
      bill_date: '2026-03-05',
      amount: 5,
      status: BillStatus.DRAFT,
      ai_request: aiRequestId,
    });

    expect(await draftIds()).toEqual([draft]);
    await http('get', `/drafts/${draft}/image`).expect(200);

    await del(draft).expect(204);

    expect(await draftIds()).toEqual([]);
    await http('get', `/drafts/${draft}/image`).expect(404);
    await http('get', `/${draft}`).expect(404);
    await http('post', `/${draft}/confirm`)
      .send({
        bill_date: '2026-03-05',
        total_amount: 5,
        items: [{ raw_name: 'item', product_count: 1, amount: 5 }],
      })
      .expect(404);
    expect(await listIds()).toEqual([]);
    expect((await dashboard()).total).toBe(0);
  });

  it('removes a duplicate from the list with duplicates, totals unchanged', async () => {
    const original = await seedBill({ bill_date: '2026-03-05', amount: 10 });
    const copy = await seedBill({
      bill_date: '2026-03-05',
      amount: 10,
      status: BillStatus.DUPLICATE,
      duplicate_of: original,
    });
    expect((await listIds('&include_duplicates=true')).sort()).toEqual(
      [original, copy].sort(),
    );

    await del(copy).expect(204);

    expect(await listIds('&include_duplicates=true')).toEqual([original]);
    await http('get', `/${copy}`).expect(404);
    await http('get', `/${original}`).expect(200);
    expect((await dashboard()).total).toBe(10);
    expect(await breakdownTotal()).toBe(10);
  });

  it('keeps the purchase counted once when the original of a duplicate is deleted', async () => {
    const original = await seedBill({ bill_date: '2026-03-05', amount: 10 });
    const copy = await seedBill({
      bill_date: '2026-03-05',
      amount: 10,
      status: BillStatus.DUPLICATE,
      duplicate_of: original,
    });

    await del(original).expect(204);

    expect(await listIds()).toEqual([copy]);
    expect(await dashboard()).toEqual({ ids: [copy], total: 10 });
    expect(await breakdownTotal()).toBe(10);
  });
});
