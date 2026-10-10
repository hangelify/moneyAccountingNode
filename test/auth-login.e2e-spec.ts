import { createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getStorageToken } from '@nestjs/throttler';
import type { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { EntityManager } from '@mikro-orm/core';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

// Wrap the real bcrypt so calls can be counted (its exports are not spy-able).
jest.mock('bcrypt', () => {
  const actual = jest.requireActual<typeof import('bcrypt')>('bcrypt');
  const compare = (data: string, hash: string): Promise<boolean> =>
    actual.compare(data, hash);
  return { ...actual, compare: jest.fn(compare) };
});

describe('Auth login hardening (e2e)', () => {
  let app: INestApplication<App>;
  const password = 'Qwerty123';
  const email = `login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  // Throttler counters live in Redis and survive between runs; drop the ones
  // this suite hits so it starts from a clean 0/10.
  async function resetThrottle(handler: string) {
    const { redis } = app.get<ThrottlerStorageRedisService>(getStorageToken());
    const keys = ['127.0.0.1', '::ffff:127.0.0.1', '::1'].flatMap((tracker) => {
      const key = createHash('sha256')
        .update(`AuthController-${handler}-default-${tracker}`)
        .digest('hex');
      return [`{${key}:default}:hits`, `{${key}:default}:blocked`];
    });
    await redis.del(...keys);
  }

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
    request(app.getHttpServer()).post(`/auth/login${query}`).send(body);

  beforeAll(async () => {
    process.env.JWT_SECRET =
      process.env.JWT_SECRET ||
      'test-jwt-secret-key-minimum-32-characters-long';
    process.env.JWT_REFRESH_SECRET =
      process.env.JWT_REFRESH_SECRET ||
      'test-refresh-secret-key-minimum-32-characters-long';
    process.env.JWT_EXPIRES_IN_MS = process.env.JWT_EXPIRES_IN_MS || '900000';
    process.env.JWT_REFRESH_EXPIRES_IN_MS =
      process.env.JWT_REFRESH_EXPIRES_IN_MS || '604800000';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    await resetThrottle('register');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, first_name: 'Login' })
      .expect(201);
  });

  beforeEach(async () => {
    await resetThrottle('login');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) await app.close();
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
