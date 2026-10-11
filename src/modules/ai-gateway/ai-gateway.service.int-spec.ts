import { MikroORM, EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { z } from 'zod';
import { AiRequest, AiRequestStatus } from '../../entities/ai-request.entity';
import {
  AiRequestAttempt,
  AiAttemptStatus,
  AiAttemptErrorCode,
} from '../../entities/ai-request-attempt.entity';
import { AiRequestLogger } from './internal/ai-request-logger';
import { AiGatewayService } from './ai-gateway.service';
import { Household } from '../../entities/household.entity';
import { AiTask, TaskRequest } from './types/ai-task';
import { LLM_PROVIDERS, LlmProvider } from './types/llm-provider';
import { Capability } from './types/capability';
import { LlmResponse } from './types/llm-request';
import { FakeLlmProvider } from './providers/__fixtures__/fake.provider';
import {
  AiBudgetExceededError,
  AiCapacityExceededError,
  AiGatewayExhaustedError,
  AiImageStorageError,
  AiInputInvalidError,
  NoCapableProviderError,
} from './errors';
import { STORAGE_SERVICE, StorageService } from '../storage/storage.service';
import { AI_CALL_CONFIG, AiCallConfig } from './internal/ai-call-config';
import { DeadlineExceededError } from './internal/retry';
import {
  InvalidResponseError,
  TruncatedResponseError,
} from './internal/error-classifier';
import { testAiCallConfig } from './providers/__fixtures__/call-bounds.shared';
import {
  AI_USAGE_LIMITS,
  AiUsageLimits,
  loadAiUsageLimits,
} from './internal/ai-usage-limits';
import { User } from '../../entities/user.entity';

jest.setTimeout(30_000);

// ---- Inline tasks ---------------------------------------------------------

type PingIn = { n: number };
type PingOut = { ok: boolean };

class PingTask extends AiTask<PingIn, PingOut> {
  readonly name = 'test.ping';
  readonly requiredCapabilities = new Set<Capability>(['text', 'json']);
  readonly inputSchema = z.object({ n: z.number() });
  readonly outputSchema = z.object({ ok: z.boolean() });
  readonly modelOverrides?: Partial<
    Record<'anthropic' | 'openai' | 'deepseek', string>
  >;

  constructor(
    modelOverrides?: Partial<
      Record<'anthropic' | 'openai' | 'deepseek', string>
    >,
  ) {
    super();
    this.modelOverrides = modelOverrides;
  }

  buildRequest(input: PingIn): Promise<TaskRequest> {
    return Promise.resolve({
      messages: [
        { role: 'system', text: 'You are a ping responder.' },
        { role: 'user', text: `n=${input.n}` },
      ],
    });
  }
}

class TunedPingTask extends PingTask {
  override readonly maxOutputTokens = 321;
  override readonly temperature = 0.2;

  constructor(private readonly requestOverrides: Partial<TaskRequest> = {}) {
    super();
  }

  override async buildRequest(input: PingIn): Promise<TaskRequest> {
    return { ...(await super.buildRequest(input)), ...this.requestOverrides };
  }
}

type VisionIn = { data: Buffer };
type VisionOut = { ok: boolean };

class VisionPingTask extends AiTask<VisionIn, VisionOut> {
  readonly name = 'test.vision-ping';
  readonly requiredCapabilities = new Set<Capability>([
    'text',
    'vision',
    'json',
  ]);
  readonly inputSchema = z.object({
    data: z.instanceof(Buffer),
  }) as unknown as z.ZodType<VisionIn>;
  readonly outputSchema = z.object({ ok: z.boolean() });

  buildRequest(input: VisionIn): Promise<TaskRequest> {
    return Promise.resolve({
      messages: [
        {
          role: 'user',
          text: 'Describe the image.',
          images: [{ data: input.data, mediaType: 'image/png' }],
        },
      ],
    });
  }
}

// ---- Helpers --------------------------------------------------------------

function okResponse(json: unknown, text?: string): () => Promise<LlmResponse> {
  return () =>
    Promise.resolve({
      text: text ?? JSON.stringify(json),
      json,
      model: 'fake-model',
      usage: { inputTokens: 10, outputTokens: 10 },
    });
}

function errResponse(err: unknown): () => Promise<LlmResponse> {
  return () =>
    new Promise<LlmResponse>((_resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(err);
    });
}

async function buildModule(
  providers: LlmProvider[],
  mockStorage: StorageService,
  config: AiCallConfig,
  limits: AiUsageLimits,
) {
  return Test.createTestingModule({
    imports: [
      MikroOrmModule.forRoot({
        driver: PostgreSqlDriver,
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        dbName: process.env.DB_NAME || 'accounting',
        entities: ['./dist/**/*.entity.js'],
        entitiesTs: ['./src/**/*.entity.ts'],
        allowGlobalContext: true,
      }),
    ],
    providers: [
      AiRequestLogger,
      AiGatewayService,
      { provide: LLM_PROVIDERS, useValue: providers },
      { provide: STORAGE_SERVICE, useValue: mockStorage },
      { provide: AI_CALL_CONFIG, useValue: config },
      { provide: AI_USAGE_LIMITS, useValue: limits },
    ],
  }).compile();
}

// ---- Tests ----------------------------------------------------------------

// Each test uses task_name in this set; cleanup + assertions scope by it so
// this spec can run in parallel with ai-request-logger.spec without stepping
// on shared tables.
const OWNED_TASK_NAMES = ['test.ping', 'test.vision-ping'] as const;

describe('AiGatewayService', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let putSpy: jest.Mock<
    Promise<{ key: string }>,
    [Buffer, 'image/png' | 'image/jpeg' | 'image/webp', string?]
  >;
  let mockStorage: StorageService;
  let logger: AiRequestLogger;

  async function boot(
    providers: LlmProvider[],
    config: AiCallConfig = testAiCallConfig(),
    limits: Partial<AiUsageLimits> = {},
  ) {
    const mod = await buildModule(providers, mockStorage, config, {
      ...loadAiUsageLimits({}),
      ...limits,
    });
    orm = mod.get(MikroORM);
    em = orm.em;
    logger = mod.get(AiRequestLogger);
    return mod.get(AiGatewayService);
  }

  beforeEach(() => {
    putSpy = jest
      .fn<
        Promise<{ key: string }>,
        [Buffer, 'image/png' | 'image/jpeg' | 'image/webp', string?]
      >()
      .mockResolvedValue({ key: 'ai/images/fake.png' });
    mockStorage = {
      put: putSpy,
      exists: jest.fn().mockResolvedValue(true),
      getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/x'),
    };
  });

  afterEach(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  async function cleanupOwnedRows() {
    const fork = em.fork();
    const parents = await fork.find(
      AiRequest,
      { task_name: { $in: [...OWNED_TASK_NAMES] } },
      { fields: ['id'] },
    );
    if (parents.length === 0) return;
    const ids = parents.map((p) => p.id);
    await (fork
      .getConnection()
      .execute('DELETE FROM ai_request_attempts WHERE ai_request_id IN (?)', [
        ids,
      ]) as Promise<unknown>);
    await (fork
      .getConnection()
      .execute('DELETE FROM ai_requests WHERE id IN (?)', [
        ids,
      ]) as Promise<unknown>);
  }

  async function findOwnedParents() {
    return em.fork().find(AiRequest, {
      task_name: { $in: [...OWNED_TASK_NAMES] },
    });
  }

  async function findOwnedAttempts(orderBy?: { attempt_number: 'asc' }) {
    return em.fork().find(
      AiRequestAttempt,
      {
        ai_request: { task_name: { $in: [...OWNED_TASK_NAMES] } },
      },
      orderBy ? { orderBy } : undefined,
    );
  }

  it('succeeds on first provider and logs one SUCCESS attempt', async () => {
    const fake = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [okResponse({ ok: true })],
    );
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    const out = await svc.run(new PingTask(), { n: 1 });

    const parents = await findOwnedParents();
    expect(out).toEqual({ data: { ok: true }, requestId: parents[0].id });
    expect(parents).toHaveLength(1);
    expect(parents[0].status).toBe(AiRequestStatus.SUCCESS);
    expect(parents[0].task_name).toBe('test.ping');
    const attempts = await findOwnedAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe(AiAttemptStatus.SUCCESS);
    expect(attempts[0].provider_name).toBe('openai');
    expect(parents[0].chosen_attempt_id).toBe(attempts[0].id);
  });

  it('stores the successful answer once, as the parent final_output', async () => {
    const fake = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [okResponse({ ok: true })],
    );
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    await svc.run(new PingTask(), { n: 1 });

    const [parent] = await findOwnedParents();
    expect(parent.final_output).toEqual({ ok: true });
    const [attempt] = await findOwnedAttempts();
    expect(attempt.raw_response_text).toBeNull();
    expect(attempt.parsed_json).toBeNull();
  });

  it("passes the task's maxOutputTokens and temperature to the provider", async () => {
    const fake = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [okResponse({ ok: true })],
    );
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    await svc.run(new TunedPingTask(), { n: 1 });

    expect(fake.requests[0]).toMatchObject({
      maxOutputTokens: 321,
      temperature: 0.2,
    });
  });

  it('lets the built request override the task defaults', async () => {
    const fake = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [okResponse({ ok: true })],
    );
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    await svc.run(new TunedPingTask({ maxOutputTokens: 99, temperature: 0 }), {
      n: 1,
    });

    expect(fake.requests[0]).toMatchObject({
      maxOutputTokens: 99,
      temperature: 0,
    });
  });

  it('records a truncated answer as TRUNCATED with its raw body', async () => {
    const fake = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [
        errResponse(
          new TruncatedResponseError('cut off', '{"ok":', {
            inputTokens: 11,
            outputTokens: 321,
          }),
        ),
      ],
    );
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    await expect(svc.run(new PingTask(), { n: 1 })).rejects.toBeInstanceOf(
      AiGatewayExhaustedError,
    );

    const [attempt] = await findOwnedAttempts();
    expect(attempt.error_code).toBe(AiAttemptErrorCode.TRUNCATED);
    expect(attempt.raw_response_text).toBe('{"ok":');
    expect(attempt.output_tokens).toBe(321);
  });

  it('fails over when the first provider returns schema-invalid JSON', async () => {
    const p1 = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [okResponse({ foo: 'bar' }, 'raw-invalid-text')],
    );
    const p2 = new FakeLlmProvider(
      'deepseek',
      new Set<Capability>(['text', 'json']),
      [okResponse({ ok: false })],
    );
    const svc = await boot([p1, p2]);
    await cleanupOwnedRows();

    const out = await svc.run(new PingTask(), { n: 2 });
    expect(out.data).toEqual({ ok: false });

    const parents = await findOwnedParents();
    expect(parents).toHaveLength(1);
    expect(parents[0].status).toBe(AiRequestStatus.SUCCESS);

    const attempts = await findOwnedAttempts({ attempt_number: 'asc' });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe(AiAttemptStatus.FAILED);
    expect(attempts[0].error_code).toBe(AiAttemptErrorCode.SCHEMA_INVALID);
    expect(attempts[0].raw_response_text).toBe('raw-invalid-text');
    expect(attempts[1].status).toBe(AiAttemptStatus.SUCCESS);
    expect(attempts[1].provider_name).toBe('deepseek');
    expect(parents[0].chosen_attempt_id).toBe(attempts[1].id);
  });

  it('fails over when the first provider throws a non-transient error', async () => {
    const p1 = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [errResponse({ status: 500, transient: false })],
    );
    const p2 = new FakeLlmProvider(
      'deepseek',
      new Set<Capability>(['text', 'json']),
      [okResponse({ ok: true })],
    );
    const svc = await boot([p1, p2]);
    await cleanupOwnedRows();

    const out = await svc.run(new PingTask(), { n: 3 });
    expect(out.data).toEqual({ ok: true });

    const parents = await findOwnedParents();
    expect(parents).toHaveLength(1);
    expect(parents[0].status).toBe(AiRequestStatus.SUCCESS);

    const attempts = await findOwnedAttempts({ attempt_number: 'asc' });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe(AiAttemptStatus.FAILED);
    expect(attempts[0].error_code).toBe(AiAttemptErrorCode.SERVER_ERROR);
    expect(attempts[1].status).toBe(AiAttemptStatus.SUCCESS);
  });

  it('throws AiGatewayExhaustedError when all providers fail', async () => {
    const p1 = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [errResponse({ status: 500, transient: false })],
    );
    const p2 = new FakeLlmProvider(
      'deepseek',
      new Set<Capability>(['text', 'json']),
      [okResponse({ not: 'matching' })],
    );
    const svc = await boot([p1, p2]);
    await cleanupOwnedRows();

    let caught: unknown;
    try {
      await svc.run(new PingTask(), { n: 4 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiGatewayExhaustedError);
    const exhausted = caught as AiGatewayExhaustedError;
    expect(exhausted.parentId).toBeTruthy();
    // A 5xx, then an answer that misses the schema.
    expect(exhausted.failures).toEqual(['unavailable', 'other']);

    const parents = await findOwnedParents();
    expect(parents).toHaveLength(1);
    expect(parents[0].id).toBe(exhausted.parentId);
    expect(parents[0].status).toBe(AiRequestStatus.FAILED);

    const attempts = await findOwnedAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.status === AiAttemptStatus.FAILED)).toBe(
      true,
    );
  });

  it('reports every attempt as rejected when all providers refuse the request', async () => {
    const p1 = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [errResponse({ status: 400, message: 'invalid image' })],
    );
    const p2 = new FakeLlmProvider(
      'deepseek',
      new Set<Capability>(['text', 'json']),
      [errResponse({ status: 422, message: 'unprocessable' })],
    );
    const svc = await boot([p1, p2]);
    await cleanupOwnedRows();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const err = await svc
      .run(new PingTask(), { n: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiGatewayExhaustedError);
    expect((err as AiGatewayExhaustedError).failures).toEqual([
      'rejected',
      'rejected',
    ]);
    // A bug of ours rejected by every provider must stand out in the logs.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failures: rejected, rejected'),
    );
    warn.mockRestore();
  });

  describe('task deadline', () => {
    /** Hangs until the deadline aborts it, recording what it saw. */
    function hangUntilAborted(seen: AbortSignal[]) {
      return (opts?: { signal?: AbortSignal }) =>
        new Promise<LlmResponse>((_resolve, reject) => {
          const signal = opts!.signal!;
          seen.push(signal);
          signal.addEventListener('abort', () =>
            reject(signal.reason as Error),
          );
        });
    }

    it('aborts the in-flight call and skips the remaining providers', async () => {
      const seen: AbortSignal[] = [];
      const p1 = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [hangUntilAborted(seen)],
      );
      const p2Step = jest.fn(okResponse({ ok: true }));
      const p2 = new FakeLlmProvider(
        'deepseek',
        new Set<Capability>(['text', 'json']),
        [p2Step],
      );
      const svc = await boot(
        [p1, p2],
        testAiCallConfig({ taskDeadlineMs: 150, minAttemptBudgetMs: 50 }),
      );
      await cleanupOwnedRows();

      const err = await svc
        .run(new PingTask(), { n: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiGatewayExhaustedError);
      expect((err as AiGatewayExhaustedError).lastError).toBeInstanceOf(
        DeadlineExceededError,
      );
      expect(seen).toHaveLength(1);
      expect(seen[0].aborted).toBe(true);
      expect(p2Step).not.toHaveBeenCalled();

      const attempts = await findOwnedAttempts();
      expect(attempts).toHaveLength(1);
      expect(attempts[0].error_code).toBe(AiAttemptErrorCode.TIMEOUT);
      const parents = await findOwnedParents();
      expect(parents[0].status).toBe(AiRequestStatus.FAILED);
    });

    it('bounds a provider that ignores the abort signal', async () => {
      const p1 = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [() => new Promise<LlmResponse>(() => undefined)],
      );
      const svc = await boot(
        [p1],
        testAiCallConfig({ taskDeadlineMs: 100, minAttemptBudgetMs: 10 }),
      );
      await cleanupOwnedRows();

      const err = await svc
        .run(new PingTask(), { n: 1 })
        .catch((e: unknown) => e);
      expect((err as AiGatewayExhaustedError).lastError).toBeInstanceOf(
        DeadlineExceededError,
      );
    });

    it('does not start the next provider when too little budget is left', async () => {
      const p1 = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [
          () =>
            new Promise<LlmResponse>((_resolve, reject) =>
              setTimeout(() => reject(new Error('permanent')), 150),
            ),
        ],
      );
      const p2Step = jest.fn(okResponse({ ok: true }));
      const p2 = new FakeLlmProvider(
        'deepseek',
        new Set<Capability>(['text', 'json']),
        [p2Step],
      );
      const svc = await boot(
        [p1, p2],
        testAiCallConfig({ taskDeadlineMs: 300, minAttemptBudgetMs: 200 }),
      );
      await cleanupOwnedRows();

      const err = await svc
        .run(new PingTask(), { n: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiGatewayExhaustedError);
      // The skipped provider ran out of time rather than failing.
      expect((err as AiGatewayExhaustedError).failures).toEqual([
        'other',
        'unavailable',
      ]);
      expect(p2Step).not.toHaveBeenCalled();
      const attempts = await findOwnedAttempts();
      expect(attempts).toHaveLength(1);
    });

    it('always tries the first provider, whatever the budget', async () => {
      const p1 = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [okResponse({ ok: true })],
      );
      const svc = await boot(
        [p1],
        testAiCallConfig({ taskDeadlineMs: 5_000, minAttemptBudgetMs: 10_000 }),
      );
      await cleanupOwnedRows();

      await expect(svc.run(new PingTask(), { n: 1 })).resolves.toMatchObject({
        data: { ok: true },
      });
    });

    it('still fails over while enough budget is left', async () => {
      const p1 = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [errResponse(new Error('permanent'))],
      );
      const p2 = new FakeLlmProvider(
        'deepseek',
        new Set<Capability>(['text', 'json']),
        [okResponse({ ok: true })],
      );
      const svc = await boot(
        [p1, p2],
        testAiCallConfig({ taskDeadlineMs: 5_000, minAttemptBudgetMs: 100 }),
      );
      await cleanupOwnedRows();

      await expect(svc.run(new PingTask(), { n: 1 })).resolves.toMatchObject({
        data: { ok: true },
      });
    });
  });

  it('uploads user-message images and records S3 keys on the parent row', async () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    const fake = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'vision', 'json']),
      [okResponse({ ok: true })],
    );
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    const out = await svc.run(new VisionPingTask(), { data: buf });
    expect(out.data).toEqual({ ok: true });

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith(buf, 'image/png', undefined);

    const parents = await findOwnedParents();
    expect(parents).toHaveLength(1);
    expect(parents[0].image_s3_keys).toEqual(['ai/images/fake.png']);
  });

  it("records the household and stores its images in the household's folder", async () => {
    const fork = em.fork();
    const user = fork.create(User, {
      first_name: 'Household',
      email: `hh-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      password: 'x',
    } as never);
    const household = fork.create(Household, {
      name: 'AI household',
      created_by: user,
    } as never);
    await fork.flush();
    const buf = Buffer.from([1, 2, 3, 4]);
    const fake = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'vision', 'json']),
      [okResponse({ ok: true })],
    );
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    try {
      await svc.run(
        new VisionPingTask(),
        { data: buf },
        { householdId: household.id },
      );

      expect(putSpy).toHaveBeenCalledWith(buf, 'image/png', household.id);
      const [parent] = await findOwnedParents();
      expect(parent.household?.id).toBe(household.id);
    } finally {
      await cleanupOwnedRows();
      const conn = em.fork().getConnection();
      await conn.execute('DELETE FROM households WHERE id = ?', [household.id]);
      await conn.execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
  });

  it('uses modelOverrides when resolving the attempt model', async () => {
    const fake = new FakeLlmProvider(
      'anthropic',
      new Set<Capability>(['text', 'json']),
      [okResponse({ ok: true })],
      { defaultModel: 'claude-haiku-default' },
    );
    const task = new PingTask({ anthropic: 'claude-opus-4-7' });
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    await svc.run(task, { n: 5 });

    const attempts = await findOwnedAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].model).toBe('claude-opus-4-7');
    expect(attempts[0].provider_name).toBe('anthropic');
  });

  it('throws Zod input validation error before touching the DB or any provider', async () => {
    const completeSpy = jest.fn();
    const fake: LlmProvider = {
      name: 'openai',
      capabilities: new Set<Capability>(['text', 'json']),
      isConfigured: true,
      defaultModel: 'fake-model',
      complete: completeSpy,
      isTransient: () => false,
    };
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    await expect(
      // Invalid: `n` is not a number
      svc.run(new PingTask(), { n: 'nope' } as unknown as PingIn),
    ).rejects.toBeInstanceOf(AiInputInvalidError);

    expect(completeSpy).not.toHaveBeenCalled();
    const parents = await findOwnedParents();
    expect(parents).toHaveLength(0);
  });

  it('throws NoCapableProviderError and marks the parent FAILED when no provider matches required caps', async () => {
    // Task needs vision but provider only supports text/json.
    const fake = new FakeLlmProvider(
      'openai',
      new Set<Capability>(['text', 'json']),
      [],
    );
    const svc = await boot([fake]);
    await cleanupOwnedRows();

    const buf = Buffer.from([9, 9, 9]);
    const err = await svc
      .run(new VisionPingTask(), { data: buf })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoCapableProviderError);

    const parents = await findOwnedParents();
    expect(parents).toHaveLength(1);
    expect((err as NoCapableProviderError).requestId).toBe(parents[0].id);
    expect(parents[0].status).toBe(AiRequestStatus.FAILED);
    expect(parents[0].error_message).toMatch(/no capable provider/i);
    // The image is not stored when no provider could ever read it.
    expect(putSpy).not.toHaveBeenCalled();

    const attempts = await findOwnedAttempts();
    expect(attempts).toHaveLength(0);
  });

  describe('audit safety', () => {
    let logError: jest.SpyInstance;

    beforeEach(() => {
      logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      logError.mockRestore();
    });

    it('returns the paid result and calls no other provider when recording the success fails', async () => {
      const p1 = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [okResponse({ ok: true })],
      );
      const p2Step = jest.fn(okResponse({ ok: false }));
      const p2 = new FakeLlmProvider(
        'deepseek',
        new Set<Capability>(['text', 'json']),
        [p2Step],
      );
      const svc = await boot([p1, p2]);
      await cleanupOwnedRows();
      jest
        .spyOn(logger, 'finishAttempt')
        .mockRejectedValueOnce(new Error('db down'));

      const out = await svc.run(new PingTask(), { n: 1 });

      expect(out.data).toEqual({ ok: true });
      expect(p2Step).not.toHaveBeenCalled();
      // The usage is only in memory now: the log is what lets cost be reconciled.
      expect(logError).toHaveBeenCalledWith(
        expect.stringMatching(/"inputTokens":10.*db down/),
        expect.anything(),
      );
    });

    it('still calls the provider when opening the attempt row fails', async () => {
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [okResponse({ ok: true })],
      );
      const svc = await boot([fake]);
      await cleanupOwnedRows();
      jest
        .spyOn(logger, 'beginAttempt')
        .mockRejectedValueOnce(new Error('db down'));

      const out = await svc.run(new PingTask(), { n: 1 });

      expect(out.data).toEqual({ ok: true });
      expect(await findOwnedAttempts()).toHaveLength(0);
      const [parent] = await findOwnedParents();
      expect(parent.status).toBe(AiRequestStatus.SUCCESS);
    });

    it('returns the data when closing the parent row fails', async () => {
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [okResponse({ ok: true })],
      );
      const svc = await boot([fake]);
      await cleanupOwnedRows();
      jest.spyOn(logger, 'finish').mockRejectedValueOnce(new Error('db down'));

      const out = await svc.run(new PingTask(), { n: 1 });

      expect(out.data).toEqual({ ok: true });
      const parents = await findOwnedParents();
      expect(out.requestId).toBe(parents[0].id);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('db down'),
        expect.anything(),
      );
    });

    it('still fails over when recording a failed attempt fails', async () => {
      const p1 = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [errResponse(new Error('permanent'))],
      );
      const p2 = new FakeLlmProvider(
        'deepseek',
        new Set<Capability>(['text', 'json']),
        [okResponse({ ok: true })],
      );
      const svc = await boot([p1, p2]);
      await cleanupOwnedRows();
      jest
        .spyOn(logger, 'finishAttempt')
        .mockRejectedValueOnce(new Error('db down'));

      await expect(svc.run(new PingTask(), { n: 1 })).resolves.toMatchObject({
        data: { ok: true },
      });
    });

    it('reports provider exhaustion, not the audit error, when closing a failed request fails', async () => {
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [errResponse(new Error('permanent'))],
      );
      const svc = await boot([fake]);
      await cleanupOwnedRows();
      jest.spyOn(logger, 'finish').mockRejectedValueOnce(new Error('db down'));

      await expect(svc.run(new PingTask(), { n: 1 })).rejects.toBeInstanceOf(
        AiGatewayExhaustedError,
      );
    });

    it('keeps the attempt PENDING while the provider call runs', async () => {
      let statusDuringCall: AiAttemptStatus | undefined;
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [
          async () => {
            const [attempt] = await findOwnedAttempts();
            statusDuringCall = attempt.status;
            return okResponse({ ok: true })();
          },
        ],
      );
      const svc = await boot([fake]);
      await cleanupOwnedRows();

      await svc.run(new PingTask(), { n: 1 });

      expect(statusDuringCall).toBe(AiAttemptStatus.PENDING);
      const [attempt] = await findOwnedAttempts();
      expect(attempt.status).toBe(AiAttemptStatus.SUCCESS);
    });

    it('records tokens and the raw body of an unparseable provider response', async () => {
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [
          errResponse(
            new InvalidResponseError('non-JSON', 'not json {', {
              inputTokens: 11,
              outputTokens: 13,
            }),
          ),
        ],
      );
      const svc = await boot([fake]);
      await cleanupOwnedRows();

      await expect(svc.run(new PingTask(), { n: 1 })).rejects.toBeInstanceOf(
        AiGatewayExhaustedError,
      );

      const [attempt] = await findOwnedAttempts();
      expect(attempt.error_code).toBe(AiAttemptErrorCode.INVALID_RESPONSE);
      expect(attempt.raw_response_text).toBe('not json {');
      expect(attempt.input_tokens).toBe(11);
      expect(attempt.output_tokens).toBe(13);
    });

    it('records a failed image upload in the audit', async () => {
      const step = jest.fn(okResponse({ ok: true }));
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'vision', 'json']),
        [step],
      );
      const svc = await boot([fake]);
      await cleanupOwnedRows();
      putSpy.mockRejectedValueOnce(new Error('s3 down'));

      const err = await svc
        .run(new VisionPingTask(), { data: Buffer.from([1]) })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AiImageStorageError);
      expect((err as AiImageStorageError).cause).toEqual(new Error('s3 down'));
      expect(step).not.toHaveBeenCalled();
      const parents = await findOwnedParents();
      expect(parents).toHaveLength(1);
      expect((err as AiImageStorageError).requestId).toBe(parents[0].id);
      expect(parents[0].status).toBe(AiRequestStatus.FAILED);
      expect(parents[0].error_message).toMatch(/s3 down/);
    });
  });

  describe('daily budget', () => {
    let userId: string;

    beforeEach(() => {
      userId = '';
    });

    afterEach(async () => {
      if (userId) {
        await em
          .fork()
          .getConnection()
          .execute('DELETE FROM users WHERE id = ?', [userId]);
      }
    });

    async function createUser(): Promise<string> {
      const fork = em.fork();
      const user = fork.create(User, {
        first_name: 'Budget',
        email: `budget-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'x',
      } as never);
      await fork.persist(user).flush();
      return user.id;
    }

    /** A finished audit row of `costUsd`, `hoursAgo` hours back. */
    async function spend(costUsd: number, hoursAgo = 0) {
      await em
        .fork()
        .getConnection()
        .execute(
          `INSERT INTO ai_requests
             (id, task_name, user_id, status, required_capabilities, prompt,
              total_cost_usd, created_at, updated_at)
           VALUES (gen_random_uuid(), 'test.ping', ?, 'SUCCESS', '[]', '{"messages":[]}',
              ?, NOW() - make_interval(hours => ?), NOW())`,
          [userId, costUsd, hoursAgo],
        );
    }

    it('refuses before uploading or calling a provider once the 24h spend reaches the budget', async () => {
      const step = jest.fn(okResponse({ ok: true }));
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'vision', 'json']),
        [step],
      );
      const svc = await boot([fake], undefined, { dailyBudgetUsd: 1 });
      await cleanupOwnedRows();
      userId = await createUser();
      await spend(0.6);
      await spend(0.4);

      const err: unknown = await svc
        .run(new VisionPingTask(), { data: Buffer.from([1]) }, { userId })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AiBudgetExceededError);
      expect(err).toMatchObject({ spentUsd: 1, budgetUsd: 1 });
      expect(step).not.toHaveBeenCalled();
      expect(putSpy).not.toHaveBeenCalled();
      expect(await findOwnedParents()).toHaveLength(2);
    });

    it('lets the call through while under budget, ignoring spend older than 24h', async () => {
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [okResponse({ ok: true })],
      );
      const svc = await boot([fake], undefined, { dailyBudgetUsd: 1 });
      await cleanupOwnedRows();
      userId = await createUser();
      await spend(0.9);
      await spend(5, 25);

      await expect(
        svc.run(new PingTask(), { n: 1 }, { userId }),
      ).resolves.toMatchObject({ data: { ok: true } });
    });
  });

  describe('concurrency limit', () => {
    function deferred() {
      let resolve!: (r: LlmResponse) => void;
      const promise = new Promise<LlmResponse>((r) => (resolve = r));
      return { promise, resolve };
    }

    const okJson: LlmResponse = {
      text: '{"ok":true}',
      json: { ok: true },
      model: 'fake-model',
      usage: { inputTokens: 1, outputTokens: 1 },
    };

    it('refuses a call beyond AI_MAX_CONCURRENCY and frees the slot when a call ends', async () => {
      const first = deferred();
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [() => first.promise, okResponse({ ok: true })],
      );
      const svc = await boot([fake], undefined, { maxConcurrency: 1 });
      await cleanupOwnedRows();

      const running = svc.run(new PingTask(), { n: 1 });
      const err: unknown = await svc
        .run(new PingTask(), { n: 2 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiCapacityExceededError);
      expect((err as AiCapacityExceededError).retryAfterSec).toBeGreaterThan(0);

      first.resolve(okJson);
      await expect(running).resolves.toMatchObject({ data: { ok: true } });
      await expect(svc.run(new PingTask(), { n: 3 })).resolves.toMatchObject({
        data: { ok: true },
      });
    });

    it('frees the slot when a call fails', async () => {
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [errResponse(new Error('boom')), okResponse({ ok: true })],
      );
      const svc = await boot([fake], undefined, { maxConcurrency: 1 });
      await cleanupOwnedRows();

      await expect(svc.run(new PingTask(), { n: 1 })).rejects.toBeInstanceOf(
        AiGatewayExhaustedError,
      );
      await expect(svc.run(new PingTask(), { n: 2 })).resolves.toMatchObject({
        data: { ok: true },
      });
    });

    it('frees the slot when the task input is invalid', async () => {
      const fake = new FakeLlmProvider(
        'openai',
        new Set<Capability>(['text', 'json']),
        [okResponse({ ok: true })],
      );
      const svc = await boot([fake], undefined, { maxConcurrency: 1 });
      await cleanupOwnedRows();

      await expect(
        svc.run(new PingTask(), { n: 'x' } as unknown as PingIn),
      ).rejects.toThrow();
      await expect(svc.run(new PingTask(), { n: 2 })).resolves.toMatchObject({
        data: { ok: true },
      });
    });
  });
});
