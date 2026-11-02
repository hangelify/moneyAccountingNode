import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, registerUser, TestUser } from './utils/app';

type Method = 'get' | 'put' | 'delete';

// Malformed ids must never reach Postgres (which answers "invalid input
// syntax for type uuid" and used to surface as a 500).
describe('UUID route params (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'uuid');
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: Method, path: string) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${user.accessToken}`);

  it('answers 403, as for a foreign household, when hid is not a UUID', async () => {
    await call('get', '/households/not-a-uuid/bills').expect(403);
    await call('get', '/households/not-a-uuid').expect(403);
  });

  // The message comes from ParseUUIDPipe, so the id is rejected before any
  // query runs (not mapped from a Postgres 22P02 by the exception filter).
  it('answers 400 from ParseUUIDPipe when a record id is not a UUID', async () => {
    const h = `/households/${user.householdId}`;
    const bases = [
      'bills',
      'budgets',
      'categories',
      'sub-categories',
      'markets',
      'planing-horizons',
    ];
    const routes: Array<[Method, string]> = [];
    for (const base of bases) {
      for (const method of ['get', 'put', 'delete'] as const) {
        routes.push([method, `${h}/${base}/abc`]);
      }
    }
    routes.push(['delete', `${h}/members/abc`]);

    for (const [method, path] of routes) {
      const res = await call(method, path);
      const { message } = res.body as { message?: unknown };
      expect({ method, path, status: res.status, message }).toEqual({
        method,
        path,
        status: 400,
        message: 'Validation failed (uuid is expected)',
      });
    }
  });
});
