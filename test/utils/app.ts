import { Test, TestingModuleBuilder } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  getOptionsToken,
  getStorageToken,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import { APP_THROTTLERS, AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { parseTrustProxy } from '../../src/config/trust-proxy';
import {
  InMemoryLoginAttemptStore,
  LOGIN_ATTEMPT_STORE,
} from '../../src/modules/auth/login-lockout/login-attempt.store';
import type { TokenResponseDto } from '../../src/modules/auth/dto/token-response.dto';
import type { HouseholdResponseDto } from '../../src/modules/household/dto/household-response.dto';

export interface TestAppOptions {
  /** TRUST_PROXY value, as main.ts would read it. */
  trustProxy?: string;
  /** Extra provider overrides (e.g. stubbing an external API). */
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/**
 * Builds AppModule configured exactly like main.ts. Rate-limit and
 * login-failure counters live in memory, per app instance, instead of Redis:
 * every app starts at zero and
 * no test needs a Redis server or leaves counters behind.
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(getOptionsToken())
    .useValue({ throttlers: APP_THROTTLERS })
    .overrideProvider(LOGIN_ATTEMPT_STORE)
    .useValue(new InMemoryLoginAttemptStore());
  if (options.override) builder = options.override(builder);

  const moduleFixture = await builder.compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    logger: ['error', 'warn'],
  });
  configureApp(app, { trustProxy: parseTrustProxy(options.trustProxy) });
  await app.init();
  return app;
}

/**
 * Saves an audited AI request under this id, for specs that stand in for the
 * AI call: a draft links to its AI request by foreign key.
 */
export async function seedAiRequest(
  app: NestExpressApplication,
  id: string,
): Promise<void> {
  await app
    .get(MikroORM)
    .em.getConnection()
    .execute(
      `insert into ai_requests (id, task_name, status, required_capabilities, prompt)
       values (?, 'e2e-stub', 'SUCCESS', '[]', '{"messages":[]}')
       on conflict (id) do nothing`,
      [id],
    );
}

/** Drops every rate-limit counter of the app. */
export function resetThrottling(app: NestExpressApplication): void {
  app.get<ThrottlerStorageService>(getStorageToken()).storage.clear();
}

export interface TestUser {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  householdId: string;
}

let userSeq = 0;

/** Registers a user; registration also creates their personal household. */
export async function registerUser(
  app: NestExpressApplication,
  label = 'user',
): Promise<TestUser> {
  const email = `${label}-${++userSeq}-${Date.now()}@example.com`;
  const password = 'password123';
  const reg = await request(app.getHttpServer())
    .post('/auth/register')
    .set('X-Client-Type', 'mobile')
    .send({ email, password, first_name: label })
    .expect(201);
  const tokens = reg.body as TokenResponseDto;

  const list = await request(app.getHttpServer())
    .get('/households')
    .set('Authorization', `Bearer ${tokens.access_token}`)
    .expect(200);

  return {
    email,
    password,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    householdId: (list.body as HouseholdResponseDto[])[0].id,
  };
}
