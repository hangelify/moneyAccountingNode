import type { NestExpressApplication } from '@nestjs/platform-express';
import { MikroORM } from '@mikro-orm/core';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { Session } from '../src/entities/session.entity';
import { RefreshToken } from '../src/entities/refresh-token.entity';
import { Log } from '../src/entities/log.entity';

describe('Trust proxy & IP-based rate limiting (e2e)', () => {
  let app: NestExpressApplication;

  // Each test gets a fresh app, so rate-limit counters start at zero.
  async function createApp(trustProxy: string | undefined): Promise<void> {
    app = await createTestApp({ trustProxy });
  }

  afterEach(async () => {
    await app.close();
  });

  it('does not let X-Forwarded-For bypass the login rate limit by default', async () => {
    await createApp(undefined);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Client-Type', 'mobile')
        .set('X-Forwarded-For', `203.0.113.${i + 1}`)
        // One email per request: the per-account lockout must not answer first.
        .send({ email: `nobody-${i}@example.com`, password: 'wrong-password' });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  it('does not fail with 500 on a garbage X-Forwarded-For when TRUST_PROXY=1', async () => {
    await createApp('1');
    const garbage = 'x'.repeat(100);

    const email = `xff-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Client-Type', 'mobile')
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
    const logs = await em.find(Log, {
      metadata: { user_id: session.user.id },
    });

    expect(session.ip_address ?? null).toBeNull();
    expect(refreshToken.ip_address ?? null).toBeNull();
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) expect(log.ip_address ?? null).toBeNull();
  });

  it('uses the client address from X-Forwarded-For when TRUST_PROXY=1', async () => {
    await createApp('1');
    const clientIp = '198.51.100.23';

    const email = `xff-ok-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Client-Type', 'mobile')
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
