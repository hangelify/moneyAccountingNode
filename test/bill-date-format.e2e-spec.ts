import type { NestExpressApplication } from '@nestjs/platform-express';
import { MikroORM } from '@mikro-orm/core';
import request from 'supertest';
import { createTestApp, registerUser, TestUser } from './utils/app';
import { Bill } from '../src/entities/bill.entity';
import { BillStatus } from '../src/types/bill-status.enum';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Every bill endpoint returns bill_date as a plain YYYY-MM-DD string.
describe('bill_date format (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;
  let base: string;
  let items: object[];

  const call = (
    method: 'get' | 'post' | 'put',
    path: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [method](`${base}${path}`)
      .set('Authorization', `Bearer ${user.accessToken}`);
    return body ? req.send(body) : req;
  };

  const date = (res: request.Response) => (res.body as Bill).bill_date;

  async function insertDraft(billDate: string): Promise<string> {
    const em = app.get(MikroORM).em.fork();
    const draft = em.create(Bill, {
      household: user.householdId,
      status: BillStatus.DRAFT,
      bill_date: billDate,
      amount: 5,
    } as never);
    await em.flush();
    return draft.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'dates');
    base = `/households/${user.householdId}`;
    const create = async (path: string, body: object) => {
      const res = await call('post', path, body).expect(201);
      return (res.body as { id: string }).id;
    };
    const budget = await create('/budgets', { name: 'Budget' });
    const horizon = await create('/planing-horizons', {
      name: 'Horizon',
      amount: 100,
      currency: 'EUR',
      period_type: 'MONTHLY',
      budget_id: budget,
    });
    const category = await create('/categories', {
      name: 'Cat',
      planing_horizon_id: horizon,
    });
    const subCategory = await create('/sub-categories', {
      name: 'Sub',
      category_id: category,
    });
    items = [
      {
        sub_category_id: subCategory,
        product_count: 1,
        amount: 5,
      },
    ];
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns YYYY-MM-DD from create, get, update and list', async () => {
    const created = await call('post', '/bills', {
      bill_date: '2026-05-19',
      total_amount: 5,
      items,
    }).expect(201);
    expect(date(created)).toBe('2026-05-19');
    const id = (created.body as { id: string }).id;

    expect(date(await call('get', `/bills/${id}`).expect(200))).toBe(
      '2026-05-19',
    );

    const updated = await call('put', `/bills/${id}`, {
      bill_date: '2026-05-20',
    }).expect(200);
    expect(date(updated)).toBe('2026-05-20');

    const list = await call('get', '/bills').expect(200);
    const dates = (list.body as { data: Bill[] }).data.map((b) => b.bill_date);
    expect(dates).toContain('2026-05-20');
    for (const d of dates) expect(d).toMatch(DAY);
  });

  it('returns YYYY-MM-DD from drafts and confirm', async () => {
    const id = await insertDraft('2026-03-02');

    const drafts = await call('get', '/bills/drafts').expect(200);
    const draft = (drafts.body as { data: Bill[] }).data.find(
      (b) => b.id === id,
    );
    expect(draft?.bill_date).toBe('2026-03-02');

    expect(date(await call('get', `/bills/${id}`).expect(200))).toBe(
      '2026-03-02',
    );

    const confirmed = await call('post', `/bills/${id}/confirm`, {
      bill_date: '2026-03-03',
      total_amount: 5,
      items,
    }).expect(200);
    expect(date(confirmed)).toBe('2026-03-03');
  });

  it.each([
    '2026-05-19T01:00+03:00',
    '2026-05-19T00:00:00.000Z',
    '2026-02-30',
    '19.05.2026',
  ])('rejects bill_date %p with 400', async (bill_date) => {
    await call('post', '/bills', { bill_date, total_amount: 5, items }).expect(
      400,
    );
  });

  it('rejects a time-bearing bill_date on update and confirm', async () => {
    const id = await insertDraft('2026-03-04');
    const bad = '2026-05-19T01:00+03:00';
    await call('put', `/bills/${id}`, { bill_date: bad }).expect(400);
    await call('post', `/bills/${id}/confirm`, {
      bill_date: bad,
      total_amount: 5,
      items,
    }).expect(400);
  });

  it('rejects a time-bearing date_from in the list filter', async () => {
    await call('get', '/bills?date_from=2026-05-19T01:00%2B03:00').expect(400);
  });
});
