import {
  CanActivate,
  Controller,
  ExecutionContext,
  INestApplication,
  Injectable,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AI_USAGE_LIMITS, AiUsageLimits } from '../internal/ai-usage-limits';
import { UserThrottlerGuard } from './user-throttler.guard';

/** Stands in for JwtAuthGuard: authenticates whoever `x-user` names. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: { id: string } }>();
    const id = req.header('x-user');
    if (id) req.user = { id };
    return true;
  }
}

@Controller()
@UseGuards(FakeAuthGuard, UserThrottlerGuard)
class AiController {
  @Post('first')
  first() {
    return 'ok';
  }

  @Post('second')
  second() {
    return 'ok';
  }
}

describe('UserThrottlerGuard', () => {
  let app: INestApplication<App>;

  async function boot(limits: Partial<AiUsageLimits> = {}) {
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1_000 }])],
      controllers: [AiController],
      providers: [
        {
          provide: AI_USAGE_LIMITS,
          useValue: {
            userPerMinute: 10,
            userPerDay: 100,
            dailyBudgetUsd: 1,
            maxConcurrency: 4,
            ...limits,
          },
        },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  }

  afterEach(async () => {
    await app?.close();
  });

  async function hit(user: string | undefined, path = '/first', ip = '') {
    const req = request(app.getHttpServer()).post(path);
    if (user) req.set('x-user', user);
    if (ip) req.set('X-Forwarded-For', ip);
    return req;
  }

  it('refuses the 11th call of a user within a minute, whatever the client IP', async () => {
    await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await hit('u1', '/first', `203.0.113.${i + 1}`)).status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
  });

  it('answers 429 with Retry-After and a message naming the AI limit', async () => {
    await boot({ userPerMinute: 1 });
    await hit('u1');
    const res = await hit('u1');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((res.body as { message: string }).message).toMatch(
      /AI request limit/i,
    );
  });

  it('counts each user separately', async () => {
    await boot({ userPerMinute: 1 });
    expect((await hit('u1')).status).toBe(201);
    expect((await hit('u2')).status).toBe(201);
    expect((await hit('u1')).status).toBe(429);
  });

  it('shares one counter across the routes it guards', async () => {
    await boot({ userPerMinute: 1 });
    expect((await hit('u1', '/first')).status).toBe(201);
    expect((await hit('u1', '/second')).status).toBe(429);
  });

  it('enforces the per-day limit', async () => {
    await boot({ userPerMinute: 100, userPerDay: 2 });
    expect((await hit('u1')).status).toBe(201);
    expect((await hit('u1')).status).toBe(201);
    const res = await hit('u1');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(60);
  });

  it('fails closed when it runs before authentication', async () => {
    await boot();
    expect((await hit(undefined)).status).toBe(500);
  });
});
