import { MikroORM, EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  AiRequest,
  AiRequestStatus,
} from '../../../entities/ai-request.entity';
import {
  AiRequestAttempt,
  AiAttemptStatus,
  AiAttemptErrorCode,
} from '../../../entities/ai-request-attempt.entity';
import { AiRequestLogger } from './ai-request-logger';

jest.setTimeout(30_000);

describe('AiRequestLogger', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let logger: AiRequestLogger;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: PostgreSqlDriver,
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432', 10),
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
          dbName: process.env.DB_NAME || 'accounting',
          // Use the same glob as the app so all entity relationships resolve.
          entities: ['./dist/**/*.entity.js'],
          entitiesTs: ['./src/**/*.entity.ts'],
          allowGlobalContext: true,
        }),
      ],
      providers: [AiRequestLogger],
    }).compile();
    orm = mod.get(MikroORM);
    em = orm.em;
    logger = mod.get(AiRequestLogger);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  // Scope cleanup to task names this spec owns, so it can run in parallel
  // with ai-gateway.service.spec.ts without truncating each other's data.
  const OWNED_TASK_NAMES = ['test.task', 't'];

  beforeEach(async () => {
    const fork = em.fork();
    const parents = await fork.find(
      AiRequest,
      { task_name: { $in: OWNED_TASK_NAMES } },
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
  });

  it('creates a PENDING parent row', async () => {
    const { parentId } = await logger.begin({
      taskName: 'test.task',
      requiredCapabilities: ['text', 'json'],
      prompt: { messages: [{ role: 'system', text: 'hi' }] },
    });
    const row = await em.fork().findOneOrFail(AiRequest, { id: parentId });
    expect(row.status).toBe(AiRequestStatus.PENDING);
    expect(row.task_name).toBe('test.task');
  });

  it('records an attempt with cost computed from the pricing table', async () => {
    const { parentId } = await logger.begin({
      taskName: 't',
      requiredCapabilities: ['text'],
      prompt: { messages: [] },
    });
    const { attemptId } = await logger.beginAttempt({
      parentId,
      providerName: 'openai',
      model: 'gpt-4o',
      attemptNumber: 1,
    });
    await logger.finishAttempt({
      attemptId,
      status: AiAttemptStatus.SUCCESS,
      rawText: '{}',
      parsedJson: {},
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      latencyMs: 123,
    });
    const att = await em
      .fork()
      .findOneOrFail(AiRequestAttempt, { id: attemptId });
    expect(Number(att.total_cost_usd)).toBeCloseTo(12.5, 6);
  });

  it('aggregates latency and cost on finish', async () => {
    const { parentId } = await logger.begin({
      taskName: 't',
      requiredCapabilities: ['text'],
      prompt: { messages: [] },
    });
    const a1 = (
      await logger.beginAttempt({
        parentId,
        providerName: 'openai',
        model: 'gpt-4o',
        attemptNumber: 1,
      })
    ).attemptId;
    await logger.finishAttempt({
      attemptId: a1,
      status: AiAttemptStatus.FAILED,
      errorCode: AiAttemptErrorCode.RATE_LIMIT,
      inputTokens: 100,
      outputTokens: 0,
      latencyMs: 100,
    });
    const a2 = (
      await logger.beginAttempt({
        parentId,
        providerName: 'openai',
        model: 'gpt-4o',
        attemptNumber: 2,
      })
    ).attemptId;
    await logger.finishAttempt({
      attemptId: a2,
      status: AiAttemptStatus.SUCCESS,
      inputTokens: 100,
      outputTokens: 100,
      latencyMs: 200,
    });
    await logger.finish({
      parentId,
      status: AiRequestStatus.SUCCESS,
      chosenAttemptId: a2,
    });
    const parent = await em.fork().findOneOrFail(AiRequest, { id: parentId });
    expect(parent.total_latency_ms).toBe(300);
    expect(parent.status).toBe(AiRequestStatus.SUCCESS);
    expect(parent.total_cost_usd).not.toBeNull();
  });

  it('leaves cost null when model is not priced', async () => {
    const { parentId } = await logger.begin({
      taskName: 't',
      requiredCapabilities: ['text'],
      prompt: { messages: [] },
    });
    const { attemptId } = await logger.beginAttempt({
      parentId,
      providerName: 'openai',
      model: 'nonexistent-model',
      attemptNumber: 1,
    });
    await logger.finishAttempt({
      attemptId,
      status: AiAttemptStatus.SUCCESS,
      inputTokens: 100,
      outputTokens: 100,
      latencyMs: 10,
    });
    const att = await em
      .fork()
      .findOneOrFail(AiRequestAttempt, { id: attemptId });
    expect(att.total_cost_usd).toBeNull();
  });

  it('opens an attempt as PENDING with no outcome yet', async () => {
    const { parentId } = await logger.begin({
      taskName: 't',
      requiredCapabilities: ['text'],
      prompt: { messages: [] },
    });
    const { attemptId } = await logger.beginAttempt({
      parentId,
      providerName: 'openai',
      model: 'gpt-4o',
      attemptNumber: 1,
    });
    const att = await em
      .fork()
      .findOneOrFail(AiRequestAttempt, { id: attemptId });
    expect(att.status).toBe(AiAttemptStatus.PENDING);
  });

  it('records uploaded image keys on the parent row', async () => {
    const { parentId } = await logger.begin({
      taskName: 't',
      requiredCapabilities: ['vision'],
      prompt: { messages: [] },
    });
    await logger.recordImages(parentId, ['ai/images/a.png']);
    const row = await em.fork().findOneOrFail(AiRequest, { id: parentId });
    expect(row.image_s3_keys).toEqual(['ai/images/a.png']);
  });

  describe('failStalePending', () => {
    async function backdate(table: string, id: string, minutes: number) {
      await em
        .fork()
        .getConnection()
        .execute(
          `UPDATE ${table} SET created_at = NOW() - make_interval(mins => ?) WHERE id = ?`,
          [minutes, id],
        );
    }

    it('fails rows left PENDING before the cutoff and totals what was recorded', async () => {
      const { parentId } = await logger.begin({
        taskName: 't',
        requiredCapabilities: ['text'],
        prompt: { messages: [] },
      });
      const done = await logger.beginAttempt({
        parentId,
        providerName: 'openai',
        model: 'gpt-4o',
        attemptNumber: 1,
      });
      await logger.finishAttempt({
        attemptId: done.attemptId,
        status: AiAttemptStatus.FAILED,
        errorCode: AiAttemptErrorCode.SCHEMA_INVALID,
        inputTokens: 1_000_000,
        outputTokens: 0,
        latencyMs: 40,
      });
      const hung = await logger.beginAttempt({
        parentId,
        providerName: 'openai',
        model: 'gpt-4o',
        attemptNumber: 2,
      });
      await backdate('ai_requests', parentId, 60);
      await backdate('ai_request_attempts', done.attemptId, 60);
      await backdate('ai_request_attempts', hung.attemptId, 60);

      await logger.failStalePending(new Date(Date.now() - 30 * 60_000));

      const fork = em.fork();
      const parent = await fork.findOneOrFail(AiRequest, { id: parentId });
      expect(parent.status).toBe(AiRequestStatus.FAILED);
      expect(parent.error_message).toMatch(/PENDING/);
      expect(Number(parent.total_cost_usd)).toBeCloseTo(2.5, 6);
      expect(parent.total_latency_ms).toBe(40);
      const att = await fork.findOneOrFail(AiRequestAttempt, {
        id: hung.attemptId,
      });
      expect(att.status).toBe(AiAttemptStatus.FAILED);
      expect(att.error_code).toBe(AiAttemptErrorCode.UNKNOWN);
    });

    it('closes a stale parent as SUCCESS when one of its attempts succeeded', async () => {
      const { parentId } = await logger.begin({
        taskName: 't',
        requiredCapabilities: ['text'],
        prompt: { messages: [] },
      });
      const { attemptId } = await logger.beginAttempt({
        parentId,
        providerName: 'openai',
        model: 'gpt-4o',
        attemptNumber: 1,
      });
      await logger.finishAttempt({
        attemptId,
        status: AiAttemptStatus.SUCCESS,
        parsedJson: { ok: true },
        inputTokens: 1_000_000,
        outputTokens: 0,
        latencyMs: 40,
      });
      await backdate('ai_requests', parentId, 60);

      await logger.failStalePending(new Date(Date.now() - 30 * 60_000));

      const parent = await em.fork().findOneOrFail(AiRequest, { id: parentId });
      expect(parent.status).toBe(AiRequestStatus.SUCCESS);
      expect(parent.chosen_attempt_id).toBe(attemptId);
      expect(parent.final_output).toEqual({ ok: true });
      expect(Number(parent.total_cost_usd)).toBeCloseTo(2.5, 6);
    });

    it('leaves rows newer than the cutoff alone', async () => {
      const { parentId } = await logger.begin({
        taskName: 't',
        requiredCapabilities: ['text'],
        prompt: { messages: [] },
      });
      const { attemptId } = await logger.beginAttempt({
        parentId,
        providerName: 'openai',
        model: 'gpt-4o',
        attemptNumber: 1,
      });

      await logger.failStalePending(new Date(Date.now() - 30 * 60_000));

      const fork = em.fork();
      const parent = await fork.findOneOrFail(AiRequest, { id: parentId });
      expect(parent.status).toBe(AiRequestStatus.PENDING);
      const att = await fork.findOneOrFail(AiRequestAttempt, { id: attemptId });
      expect(att.status).toBe(AiAttemptStatus.PENDING);
    });
  });
});
