import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import { createTestApp, registerUser, TestUser } from './utils/app';
import type {
  CategoryLimitDto,
  LimitReportCategoryDto,
  LimitReportDto,
} from '../src/modules/category-limit';
import { todayIsoDate } from '../src/common/utils/calendar-date';
import { limitPeriodEnd } from '../src/common/utils/period-range';
import { LimitPeriodType } from '../src/types/limit-period-type.enum';

describe('Category limits (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;
  let categoryId: string;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const auth = (u: TestUser): string => `Bearer ${u.accessToken}`;
  const base = (): string => `/households/${user.householdId}/category-limits`;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    user = await registerUser(app, 'limits');
    const res = await http()
      .post(`/households/${user.householdId}/categories`)
      .set('Authorization', auth(user))
      .send({ name: 'Food' })
      .expect(201);
    categoryId = (res.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
  });

  const create = (body: object): request.Test =>
    http().post(base()).set('Authorization', auth(user)).send(body);

  it('creates a limit open from the start of the current period', async () => {
    const res = await create({
      category_id: categoryId,
      period_type: 'MONTHLY',
      amount: 300,
    }).expect(201);
    const body = res.body as CategoryLimitDto;
    expect(body).toMatchObject({
      category_id: categoryId,
      category_name: 'Food',
      category_archived: false,
      period_type: 'MONTHLY',
      amount: 300,
      currency: 'EUR',
      effective_to: null,
    });
    expect(body.effective_from).toMatch(/^\d{4}-\d{2}-01$/);

    // `report` is matched before the `:categoryId` routes.
    const report = await http()
      .get(`${base()}/report?period_type=MONTHLY`)
      .set('Authorization', auth(user))
      .expect(200);
    const reported = report.body as LimitReportDto;
    expect(reported.start).toBe(body.effective_from);
    expect(reported.categories).toMatchObject([
      { category_id: categoryId, base_limit: 300, carried_in: 0, spent: 0 },
    ]);

    // The current period can be marked; the answer is the next period's row.
    const carry = (body: object): request.Test =>
      http()
        .put(`${base()}/${categoryId}/carry-over`)
        .set('Authorization', auth(user))
        .send({ period_type: 'MONTHLY', carry_over: false, ...body });
    const marked = await carry({ period_start: body.effective_from }).expect(
      200,
    );
    expect(marked.body as LimitReportCategoryDto).toMatchObject({
      category_id: categoryId,
      carried_in: 0,
      limit: 300,
    });
    for (const bad of [
      { period_start: body.effective_from.replace(/01$/, '02') },
      { period_start: reported.end },
      { period_start: body.effective_from, carry_over: 'no' },
    ]) {
      await carry(bad).expect(400);
    }
  });

  it('answers 409 when the category already has a limit', async () => {
    const body = { category_id: categoryId, period_type: 'MONTHLY', amount: 1 };
    await create(body).expect(201);
    await create(body).expect(409);
  });

  it.each([
    ['a zero amount', { amount: 0 }],
    ['an amount with 3 decimals', { amount: 1.005 }],
    ['an unknown period type', { period_type: 'WEEKLY' }],
    ['a currency in the body', { currency: 'USD' }],
  ])('answers 400 for %s', async (_label, patch) => {
    await create({
      category_id: categoryId,
      period_type: 'MONTHLY',
      amount: 10,
      ...patch,
    }).expect(400);
  });

  it('answers 404 for a category of no household of the user', async () => {
    await create({
      category_id: '123e4567-e89b-42d3-a456-426614174000',
      period_type: 'MONTHLY',
      amount: 10,
    }).expect(404);
  });

  it('replaces, lists with history, and removes a limit', async () => {
    // The yearly version is moved into last year, so the monthly one that
    // replaces it starts later whatever today is: the yearly version is
    // closed, not rewritten (or dropped in January), and stays as history.
    await create({
      category_id: categoryId,
      period_type: 'YEARLY',
      amount: 300,
    }).expect(201);
    const lastYear = String(Number(todayIsoDate().slice(0, 4)) - 1);
    await app
      .get(MikroORM)
      .em.getConnection()
      .execute(
        'update category_limits set effective_from = ? where category_id = ?',
        [`${lastYear}-01-01`, categoryId],
      );

    const put = await http()
      .put(`${base()}/${categoryId}`)
      .set('Authorization', auth(user))
      .send({ period_type: 'MONTHLY', amount: 450 })
      .expect(200);
    const replaced = put.body as CategoryLimitDto;
    expect(replaced.amount).toBe(450);

    const current = await http()
      .get(base())
      .set('Authorization', auth(user))
      .expect(200);
    expect((current.body as CategoryLimitDto[]).map((l) => l.amount)).toEqual([
      450,
    ]);

    const history = await http()
      .get(`${base()}?include_history=true`)
      .set('Authorization', auth(user))
      .expect(200);
    expect(history.body as CategoryLimitDto[]).toHaveLength(2);

    await http()
      .get(`${base()}?include_history=maybe`)
      .set('Authorization', auth(user))
      .expect(400);
    for (const qs of [
      '',
      '?period_type=WEEKLY',
      '?period_type=MONTHLY&date=2026-02-30',
    ]) {
      await http()
        .get(`${base()}/report${qs}`)
        .set('Authorization', auth(user))
        .expect(400);
    }

    const del = await http()
      .delete(`${base()}/${categoryId}`)
      .set('Authorization', auth(user))
      .expect(200);
    expect((del.body as CategoryLimitDto).effective_to).toBe(
      limitPeriodEnd(LimitPeriodType.MONTHLY, replaced.effective_from),
    );

    await http()
      .put(`${base()}/${categoryId}`)
      .set('Authorization', auth(user))
      .send({ period_type: 'MONTHLY', amount: 1 })
      .expect(404);
  });

  it('answers 403 for a household the user is not a member of', async () => {
    const other = await registerUser(app, 'stranger');
    await http()
      .get(`/households/${other.householdId}/category-limits`)
      .set('Authorization', auth(user))
      .expect(403);
    await http()
      .get(
        `/households/${other.householdId}/category-limits/report?period_type=MONTHLY`,
      )
      .set('Authorization', auth(user))
      .expect(403);
    await http()
      .put(
        `/households/${other.householdId}/category-limits/${categoryId}/carry-over`,
      )
      .set('Authorization', auth(user))
      .send({
        period_type: 'MONTHLY',
        period_start: '2026-01-01',
        carry_over: false,
      })
      .expect(403);
  });
});
