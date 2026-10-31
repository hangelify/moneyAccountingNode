import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, registerUser, TestUser } from './utils/app';

const PATH = '/bills/dashboard/spending-breakdown';

// The route through the real app: guards, the global ValidationPipe, and
// that it is not swallowed by GET /bills/:id.
describe('GET /households/:hid/bills/dashboard/spending-breakdown (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;
  let stranger: TestUser;

  const get = (as: TestUser, hid: string, query: string) =>
    request(app.getHttpServer())
      .get(`/households/${hid}${PATH}?${query}`)
      .set('Authorization', `Bearer ${as.accessToken}`);

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'spending');
    stranger = await registerUser(app, 'spending-stranger');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers the range with no series for a household without bills', async () => {
    const res = await get(
      user,
      user.householdId,
      'period=quarter&anchor=2026-10-31',
    ).expect(200);
    expect(res.body).toEqual({
      range: { period: 'quarter', start: '2026-10-01', end: '2027-01-01' },
      by_currency: [],
    });
  });

  it('rejects an invalid custom range with 400', async () => {
    const res = await get(
      user,
      user.householdId,
      'period=custom&from=2026-03-02&to=2026-03-01',
    ).expect(400);
    expect((res.body as { message: string[] }).message).toEqual([
      'to must not be before from',
    ]);
  });

  it("forbids another household's breakdown", async () => {
    await get(stranger, user.householdId, 'period=month').expect(403);
  });

  it('requires a token', async () => {
    await request(app.getHttpServer())
      .get(`/households/${user.householdId}${PATH}?period=month`)
      .expect(401);
  });

  it('is documented in Swagger', async () => {
    const res = await request(app.getHttpServer()).get('/api-json').expect(200);
    const doc = res.body as {
      paths: Record<string, { get?: { parameters: { name: string }[] } }>;
      components: { schemas: Record<string, unknown> };
    };
    const op = doc.paths[`/households/{hid}${PATH}`]?.get;
    expect(op?.parameters.map((p) => p.name)).toEqual(
      expect.arrayContaining(['period', 'anchor', 'from', 'to', 'currency']),
    );
    expect(doc.components.schemas).toHaveProperty(
      'SpendingBreakdownResponseDto',
    );
  });
});
