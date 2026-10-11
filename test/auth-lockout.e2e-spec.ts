import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import request from 'supertest';
import { createTestApp, registerUser, resetThrottling } from './utils/app';
import { Log, LogSource } from '../src/entities/log.entity';

describe('Per-account login lockout and auth audit (e2e)', () => {
  let app: NestExpressApplication;
  let seq = 0;

  const login = (email: string, password: string, ip: string, agent?: string) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .set('X-Forwarded-For', ip)
      .set('User-Agent', agent ?? 'lockout-e2e')
      .send({ email, password });

  const uniqueAgent = () => `lockout-agent-${++seq}-${Date.now()}`;

  const authLogs = (where: object) =>
    app
      .get(MikroORM)
      .em.fork()
      .find(Log, { source: LogSource.AUTH, ...where });

  beforeAll(async () => {
    // Each failed attempt below comes from its own address, so only the
    // per-account counter can stop them.
    app = await createTestApp({ trustProxy: '1' });
  });

  beforeEach(() => {
    resetThrottling(app);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the 6th attempt within the window with 429 and Retry-After, even from another IP and with the right password', async () => {
    const user = await registerUser(app, 'lockout');

    for (let i = 0; i < 5; i++) {
      const res = await login(user.email, 'wrong-password', `198.51.100.${i}`);
      expect(res.status).toBe(401);
    }

    const res = await login(user.email, user.password, '203.0.113.77');

    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts the email case-insensitively', async () => {
    const user = await registerUser(app, 'lockout-case');

    for (let i = 0; i < 5; i++) {
      const email = i % 2 ? user.email.toUpperCase() : user.email;
      await login(email, 'wrong-password', `198.51.101.${i}`).expect(401);
    }

    await login(user.email, user.password, '203.0.113.78').expect(429);
  });

  it('locks an unknown email the same way as an existing one', async () => {
    const email = `nobody-${Date.now()}@example.com`;

    for (let i = 0; i < 5; i++) {
      await login(email, 'wrong-password', `198.51.102.${i}`).expect(401);
    }

    await login(email, 'wrong-password', '203.0.113.79').expect(429);
  });

  it('resets the counter on a successful login', async () => {
    const user = await registerUser(app, 'lockout-reset');

    for (let i = 0; i < 4; i++) {
      await login(user.email, 'wrong-password', `198.51.103.${i}`).expect(401);
    }
    await login(user.email, user.password, '203.0.113.80').expect(200);

    for (let i = 0; i < 4; i++) {
      await login(user.email, 'wrong-password', `198.51.104.${i}`).expect(401);
    }
    await login(user.email, user.password, '203.0.113.81').expect(200);
  });

  it('records a failed attempt with the client IP and user agent', async () => {
    const user = await registerUser(app, 'lockout-audit');
    const agent = uniqueAgent();

    await login(user.email, 'wrong-password', '192.0.2.44', agent).expect(401);

    const logs = await authLogs({ user_agent: agent });
    expect(logs).toHaveLength(1);
    expect(logs[0].ip_address).toBe('192.0.2.44');
    expect(logs[0].metadata).toMatchObject({ success: false });
  });

  it('records a failed attempt for an unknown email with the client IP', async () => {
    const agent = uniqueAgent();

    await login(
      `ghost-${Date.now()}@example.com`,
      'wrong-password',
      '192.0.2.45',
      agent,
    ).expect(401);

    const logs = await authLogs({ user_agent: agent });
    expect(logs).toHaveLength(1);
    expect(logs[0].ip_address).toBe('192.0.2.45');
  });

  it('never writes the raw email to the logs table or stdout', async () => {
    const user = await registerUser(app, 'lockout-pii');
    const unknownEmail = `attacker-typed-${Date.now()}@example.com`;
    const agent = uniqueAgent();
    const printed: unknown[][] = [];
    for (const method of [
      'log',
      'warn',
      'error',
      'debug',
      'verbose',
    ] as const) {
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((...args: unknown[]) => {
          printed.push(args);
        });
    }

    await login(unknownEmail, 'wrong-password', '192.0.2.46', agent).expect(
      401,
    );
    await login(user.email, 'wrong-password', '192.0.2.46', agent).expect(401);
    await login(user.email, user.password, '192.0.2.46', agent).expect(200);

    const logs = await authLogs({ user_agent: agent });
    expect(logs).toHaveLength(3);
    const stored = JSON.stringify(
      logs.map((l) => ({ message: l.message, metadata: l.metadata })),
    );
    const stdout = JSON.stringify(printed);
    for (const email of [unknownEmail, user.email]) {
      expect(stored).not.toContain(email);
      expect(stdout).not.toContain(email);
    }
  });
});
