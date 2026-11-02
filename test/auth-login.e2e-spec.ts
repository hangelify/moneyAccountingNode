import type { NestExpressApplication } from '@nestjs/platform-express';
import { EntityManager } from '@mikro-orm/core';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { createTestApp, resetThrottling } from './utils/app';

// Wrap the real bcrypt so calls can be counted (its exports are not spy-able).
jest.mock('bcrypt', () => {
  const actual = jest.requireActual<typeof import('bcrypt')>('bcrypt');
  const compare = (data: string, hash: string): Promise<boolean> =>
    actual.compare(data, hash);
  return { ...actual, compare: jest.fn(compare) };
});

describe('Auth login hardening (e2e)', () => {
  let app: NestExpressApplication;
  const password = 'Qwerty123';
  const email = 'login@example.com';

  // Repositories delegate to EntityManager.findOne, so this sees both paths.
  const spyUserLookups = () => {
    const findOne = jest.spyOn(EntityManager.prototype, 'findOne');
    return () => findOne.mock.calls.map(([, where]) => where);
  };
  const hasNonStringEmail = (where: unknown) =>
    where !== null &&
    typeof where === 'object' &&
    'email' in where &&
    typeof where.email !== 'string';

  const login = (body: object, query = '') =>
    request(app.getHttpServer())
      .post(`/auth/login${query}`)
      .set('X-Client-Type', 'mobile')
      .send(body);

  beforeAll(async () => {
    app = await createTestApp();
    await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Client-Type', 'mobile')
      .send({ email, password, first_name: 'Login' })
      .expect(201);
  });

  // Login is limited to 10 per minute; each test starts from zero.
  beforeEach(() => {
    resetThrottling(app);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs in with valid credentials', async () => {
    const res = await login({ email, password });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
  });

  it.each([
    ['the matching password', password],
    ['a wrong password', 'wrong-password'],
  ])(
    'rejects an operator object as email with 400 for %s, without querying users by it',
    async (_label, pwd) => {
      const lookups = spyUserLookups();

      const res = await login({
        email: { $like: `${email.slice(0, 10)}%` },
        password: pwd,
      });

      expect(res.status).toBe(400);
      expect(lookups().filter(hasNonStringEmail)).toHaveLength(0);
    },
  );

  it('ignores credentials passed in the query string', async () => {
    const compare = jest.mocked(bcrypt.compare);
    compare.mockClear();

    const res = await login(
      {},
      `?email=${encodeURIComponent(email)}&password=${password}`,
    );
    expect(res.status).toBe(400);
    expect(compare).not.toHaveBeenCalled();
  });

  it('returns the same response for an unknown email and a wrong password', async () => {
    const unknown = await login({
      email: `nobody-${Date.now()}@example.com`,
      password: 'wrong-password',
    });
    const wrongPassword = await login({ email, password: 'wrong-password' });

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(unknown.status);
    expect(wrongPassword.body).toEqual(unknown.body);
  });

  it.each([
    ['a successful login', () => email, password, 200],
    [
      'an unknown email',
      () => `nobody-${Date.now()}@example.com`,
      password,
      401,
    ],
  ])(
    'runs bcrypt.compare exactly once for %s',
    async (_label, loginEmail, pwd, status) => {
      const compare = jest.mocked(bcrypt.compare);
      compare.mockClear();

      const res = await login({ email: loginEmail(), password: pwd });

      expect(res.status).toBe(status);
      expect(compare).toHaveBeenCalledTimes(1);
    },
  );
});
