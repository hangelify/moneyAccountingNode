import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import {
  createTestApp,
  registerUser,
  resetThrottling,
  TestUser,
} from './utils/app';
import { EXCHANGE_RATE_PROVIDER } from '../src/modules/exchange-rate/exchange-rate.provider';
import { StubProvider } from '../src/modules/exchange-rate/testing/stub-exchange-rate.provider';
import type {
  HouseholdDetailResponseDto,
  HouseholdResponseDto,
  InviteResponseDto,
} from '../src/modules/household/dto/household-response.dto';

describe('Household currency (e2e)', () => {
  let app: NestExpressApplication;
  let owner: TestUser;

  const http = () => request(app.getHttpServer());
  const auth = (user: TestUser) => `Bearer ${user.accessToken}`;

  const provider = new StubProvider('TEST-E2E');
  const RATE_DATE = '2026-03-10';

  beforeAll(async () => {
    provider.answer = (date) =>
      Promise.resolve({
        date,
        rates: [{ currency: 'EUR', rate: 20, nominal: 1 }],
      });
    app = await createTestApp({
      override: (builder) =>
        builder.overrideProvider(EXCHANGE_RATE_PROVIDER).useValue(provider),
    });
  });

  beforeEach(async () => {
    resetThrottling(app);
    owner = await registerUser(app, 'owner');
  });

  afterAll(async () => {
    const conn = app.get(MikroORM).em.getConnection();
    await conn.execute('DELETE FROM exchange_rates WHERE source = ?', [
      provider.source,
    ]);
    await conn.execute('DELETE FROM exchange_rate_days WHERE source = ?', [
      provider.source,
    ]);
    await app.close();
  });

  it('gives the personal household of a new user the EUR currency', async () => {
    const res = await http()
      .get('/households')
      .set('Authorization', auth(owner))
      .expect(200);
    const [household] = res.body as HouseholdResponseDto[];
    expect(household.currency).toBe('EUR');
  });

  it('lets the owner change the currency', async () => {
    const res = await http()
      .put(`/households/${owner.householdId}`)
      .set('Authorization', auth(owner))
      .send({ currency: 'USD' })
      .expect(200);
    expect((res.body as HouseholdResponseDto).currency).toBe('USD');

    const detail = await http()
      .get(`/households/${owner.householdId}`)
      .set('Authorization', auth(owner))
      .expect(200);
    expect((detail.body as HouseholdDetailResponseDto).currency).toBe('USD');
  });

  it('rejects a currency change by a plain member', async () => {
    const jane = await registerUser(app, 'jane');
    const invite = await http()
      .post(`/households/${owner.householdId}/invites`)
      .set('Authorization', auth(owner))
      .send({ email: jane.email })
      .expect(201);
    await http()
      .post('/households/invites/accept')
      .set('Authorization', auth(jane))
      .send({ token: (invite.body as InviteResponseDto).token })
      .expect(204);

    await http()
      .put(`/households/${owner.householdId}`)
      .set('Authorization', auth(jane))
      .send({ currency: 'USD' })
      .expect(403);
  });

  it('rejects an update with nothing to change', async () => {
    await http()
      .put(`/households/${owner.householdId}`)
      .set('Authorization', auth(owner))
      .send({})
      .expect(400);
  });

  it('rejects an unknown currency', async () => {
    await http()
      .put(`/households/${owner.householdId}`)
      .set('Authorization', auth(owner))
      .send({ currency: 'XXX' })
      .expect(400);
  });

  it('converts an MDL bill into the household currency on the dashboard', async () => {
    const h = `/households/${owner.householdId}`;
    const create = async (path: string, body: object) => {
      const res = await http()
        .post(`${h}${path}`)
        .set('Authorization', auth(owner))
        .send(body)
        .expect(201);
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
      name: 'Category',
      planing_horizon_id: horizon,
    });
    const subCategory = await create('/sub-categories', {
      name: 'Sub-category',
      category_id: category,
    });
    const market = await create('/markets', { name: 'Market' });
    await create('/bills', {
      bill_date: RATE_DATE,
      currency: 'MDL',
      total_amount: 200,
      market_id: market,
      items: [{ sub_category_id: subCategory, product_count: 1, amount: 200 }],
    });

    const dash = await http()
      .get(`${h}/bills/dashboard?type=month&year=2026&month=3`)
      .set('Authorization', auth(owner))
      .expect(200);
    const body = dash.body as {
      in_household_currency: {
        currency: string;
        period_totals: { total: number }[];
        unconverted: unknown[];
      };
      bills: { household_amount: number }[];
    };
    expect(body.in_household_currency.currency).toBe('EUR');
    expect(body.in_household_currency.unconverted).toEqual([]);
    expect(body.in_household_currency.period_totals.length).toBeGreaterThan(0);
    const total = body.in_household_currency.period_totals.reduce(
      (sum, p) => sum + Number(p.total),
      0,
    );
    expect(total).toBeCloseTo(10, 2);
    expect(typeof body.bills[0].household_amount).toBe('number');

    const breakdown = await http()
      .get(
        `${h}/bills/dashboard/spending-breakdown?period=custom&from=2026-03-01&to=2026-03-31`,
      )
      .set('Authorization', auth(owner))
      .expect(200);
    const inHousehold = (
      breakdown.body as {
        in_household_currency: { currency: string; total: number };
      }
    ).in_household_currency;
    expect(inHousehold.currency).toBe('EUR');
    expect(Number(inHousehold.total)).toBeGreaterThan(0);
  });
});
