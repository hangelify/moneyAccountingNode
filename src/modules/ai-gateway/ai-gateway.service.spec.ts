import { MikroORM, EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
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
import { AiTask, TaskRequest } from './types/ai-task';
import { LLM_PROVIDERS, LlmProvider } from './types/llm-provider';
import { Capability } from './types/capability';
import { LlmResponse } from './types/llm-request';
import { FakeLlmProvider } from './providers/__fixtures__/fake.provider';
import { AiGatewayExhaustedError, NoCapableProviderError } from './errors';
import { STORAGE_SERVICE, StorageService } from '../storage/storage.service';
import { AI_CALL_CONFIG, AiCallConfig } from './internal/ai-call-config';
import { DeadlineExceededError } from './internal/retry';
import { testAiCallConfig } from './providers/__fixtures__/call-bounds.shared';

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
    [Buffer, 'image/png' | 'image/jpeg' | 'image/webp']
  >;
  let mockStorage: StorageService;

  async function boot(
    providers: LlmProvider[],
    config: AiCallConfig = testAiCallConfig(),
  ) {
    const mod = await buildModule(providers, mockStorage, config);
    orm = mod.get(MikroORM);
    em = orm.em;
    return mod.get(AiGatewayService);
  }

  beforeEach(() => {
    putSpy = jest
      .fn<
        Promise<{ key: string }>,
        [Buffer, 'image/png' | 'image/jpeg' | 'image/webp']
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
    expect(out).toEqual({ ok: true });

    const parents = await findOwnedParents();
    expect(parents).toHaveLength(1);
    expect(parents[0].status).toBe(AiRequestStatus.SUCCESS);
    expect(parents[0].task_name).toBe('test.ping');
    const attempts = await findOwnedAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe(AiAttemptStatus.SUCCESS);
    expect(attempts[0].provider_name).toBe('openai');
    expect(parents[0].chosen_attempt_id).toBe(attempts[0].id);
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
    expect(out).toEqual({ ok: false });

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
    expect(out).toEqual({ ok: true });

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
      expect(p2Step).not.toHaveBeenCalled();
      const attempts = await findOwnedAttempts();
      expect(attempts).toHaveLength(1);
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

      await expect(svc.run(new PingTask(), { n: 1 })).resolves.toEqual({
        ok: true,
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
    expect(out).toEqual({ ok: true });

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith(buf, 'image/png');

    const parents = await findOwnedParents();
    expect(parents).toHaveLength(1);
    expect(parents[0].image_s3_keys).toEqual(['ai/images/fake.png']);
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
    ).rejects.toBeDefined();

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
    await expect(
      svc.run(new VisionPingTask(), { data: buf }),
    ).rejects.toBeInstanceOf(NoCapableProviderError);

    const parents = await findOwnedParents();
    expect(parents).toHaveLength(1);
    expect(parents[0].status).toBe(AiRequestStatus.FAILED);
    expect(parents[0].error_message).toMatch(/no capable provider/i);

    const attempts = await findOwnedAttempts();
    expect(attempts).toHaveLength(0);
  });
});
