import { createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getStorageToken } from '@nestjs/throttler';
import type { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { MikroORM } from '@mikro-orm/core';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { applyTrustProxy, parseTrustProxy } from '../src/config/trust-proxy';
import { Session } from '../src/entities/session.entity';
import { RefreshToken } from '../src/entities/refresh-token.entity';
import { Log } from '../src/entities/log.entity';

describe('Trust proxy & IP-based rate limiting (e2e)', () => {
  let app: NestExpressApplication;

  async function createApp(trustProxy: string | undefined): Promise<void> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, parseTrustProxy(trustProxy));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  }

  // Throttler counters live in Redis and survive between runs; drop the ones
  // this suite hits so it starts from a clean 0/10.
  async function resetThrottle(handler: string, trackers: string[]) {
    const { redis } = app.get<ThrottlerStorageRedisService>(getStorageToken());
    const keys = trackers.flatMap((tracker) => {
      const key = createHash('sha256')
        .update(`AuthController-${handler}-default-${tracker}`)
        .digest('hex');
      return [`{${key}:default}:hits`, `{${key}:default}:blocked`];
    });
    await redis.del(...keys);
  }

  beforeAll(() => {
    process.env.JWT_SECRET =
      process.env.JWT_SECRET ||
      'test-jwt-secret-key-minimum-32-characters-long';
    process.env.JWT_REFRESH_SECRET =
      process.env.JWT_REFRESH_SECRET ||
      'test-refresh-secret-key-minimum-32-characters-long';
    process.env.JWT_EXPIRES_IN_MS = process.env.JWT_EXPIRES_IN_MS || '900000';
    process.env.JWT_REFRESH_EXPIRES_IN_MS =
      process.env.JWT_REFRESH_EXPIRES_IN_MS || '604800000';
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('does not let X-Forwarded-For bypass the login rate limit by default', async () => {
    await createApp(undefined);
    await resetThrottle('login', ['127.0.0.1', '::ffff:127.0.0.1', '::1']);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', `203.0.113.${i + 1}`)
        .send({ email: 'nobody@example.com', password: 'wrong-password' });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  it('does not fail with 500 on a garbage X-Forwarded-For when TRUST_PROXY=1', async () => {
    await createApp('1');
    const garbage = 'x'.repeat(100);
    await resetThrottle('register', [garbage]);

    const email = `xff-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Forwarded-For', garbage)
      .send({
        email,
        password: 'password123',
        first_name: 'Xff',
        last_name: 'Tester',
        username: 'xfftester',
      });

    expect(res.status).toBe(201);

    const em = app.get(MikroORM).em.fork();
    const session = await em.findOneOrFail(Session, { user: { email } });
    const refreshToken = await em.findOneOrFail(RefreshToken, {
      user: { email },
    });
    const logs = await em.find(Log, { metadata: { email } });

    expect(session.ip_address ?? null).toBeNull();
    expect(refreshToken.ip_address ?? null).toBeNull();
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) expect(log.ip_address ?? null).toBeNull();
  });

  it('uses the client address from X-Forwarded-For when TRUST_PROXY=1', async () => {
    await createApp('1');
    const clientIp = '198.51.100.23';
    await resetThrottle('register', [clientIp]);

    const email = `xff-ok-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Forwarded-For', `10.9.9.9, ${clientIp}`)
      .send({
        email,
        password: 'password123',
        first_name: 'Xff',
        last_name: 'Tester',
        username: 'xfftester',
      })
      .expect(201);

    const em = app.get(MikroORM).em.fork();
    const session = await em.findOneOrFail(Session, { user: { email } });
    expect(session.ip_address).toBe(clientIp);
  });
});
