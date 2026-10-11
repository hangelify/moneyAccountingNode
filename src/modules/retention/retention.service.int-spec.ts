import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { AiRequest, AiRequestStatus } from '../../entities/ai-request.entity';
import {
  AiAttemptStatus,
  AiRequestAttempt,
} from '../../entities/ai-request-attempt.entity';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { Session } from '../../entities/session.entity';
import { User } from '../../entities/user.entity';
import { RetentionService } from './retention.service';

jest.setTimeout(30_000);

const DAY_MS = 86_400_000;

describe('RetentionService (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  let svc: RetentionService;
  // Rows are dated relative to the real clock: the job runs on a shared
  // database, so a far-future "now" would purge unrelated rows too.
  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * DAY_MS);

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
          entities: ['./dist/**/*.entity.js'],
          entitiesTs: ['./src/**/*.entity.ts'],
          allowGlobalContext: true,
        }),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    svc = new RetentionService(
      orm.em,
      { refreshTokenDays: 7, sessionDays: 30, aiAuditRawDays: 30 },
      2,
    );

    const em = orm.em.fork();
    const user = em.create(User, {
      first_name: 'Retention',
      email: `p33-retention-${randomUUID()}@example.com`,
      password: 'x',
    } as never);
    await em.flush();
    userId = user.id;
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = orm.em.getConnection();
    await conn.execute(
      `DELETE FROM ai_request_attempts WHERE ai_request_id IN
         (SELECT id FROM ai_requests WHERE user_id = ?)`,
      [userId],
    );
    await conn.execute('DELETE FROM ai_requests WHERE user_id = ?', [userId]);
    // Sessions and refresh tokens cascade.
    await conn.execute('DELETE FROM users WHERE id = ?', [userId]);
    await orm.close(true);
  });

  async function makeSession(fields: Partial<Session>): Promise<string> {
    const em = orm.em.fork();
    const session = em.create(Session, {
      user: em.getReference(User, userId),
      created_at: daysAgo(60),
      absolute_expires_at: new Date(now.getTime() + 30 * DAY_MS),
      is_active: true,
      ...fields,
    } as never);
    await em.flush();
    return session.id;
  }

  async function makeRefreshToken(
    sessionId: string,
    expiresAt: Date,
  ): Promise<string> {
    const em = orm.em.fork();
    const token = em.create(RefreshToken, {
      user: em.getReference(User, userId),
      session: em.getReference(Session, sessionId),
      token_hash: randomUUID().replace(/-/g, ''),
      jti: randomUUID(),
      expires_at: expiresAt,
      created_at: daysAgo(60),
    } as never);
    await em.flush();
    return token.id;
  }

  async function makeAiRequest(
    createdAt: Date,
    status = AiRequestStatus.SUCCESS,
  ): Promise<{ requestId: string; attemptId: string }> {
    const em = orm.em.fork();
    const req = em.create(AiRequest, {
      task_name: 'p33.retention',
      user: em.getReference(User, userId),
      status,
      required_capabilities: ['vision'],
      prompt: { messages: [{ role: 'user', text: 'categories...' }] },
      final_output: { raw_extracted_text: 'MILK 1.99' },
      total_cost_usd: 0.01,
      created_at: createdAt,
      updated_at: createdAt,
    } as never);
    const attempt = em.create(AiRequestAttempt, {
      ai_request: req,
      attempt_number: 1,
      provider_name: 'openai',
      model: 'gpt-4o',
      status: AiAttemptStatus.FAILED,
      raw_response_text: '{"raw_extracted_text":"MILK 1.99"',
      parsed_json: { raw_extracted_text: 'MILK 1.99' },
      latency_ms: 10,
      created_at: createdAt,
    } as never);
    await em.flush();
    // The entity stamps created_at on insert; date the row afterwards.
    await em
      .getConnection()
      .execute('UPDATE ai_requests SET created_at = ? WHERE id = ?', [
        createdAt,
        req.id,
      ]);
    return { requestId: req.id, attemptId: attempt.id };
  }

  const exists = async (entity: 'refresh_tokens' | 'sessions', id: string) =>
    (
      (await orm.em
        .getConnection()
        .execute(`SELECT 1 FROM ${entity} WHERE id = ?`, [id])) as unknown[]
    ).length === 1;

  describe('purgeRefreshTokens', () => {
    it('deletes tokens expired longer than the retention period ago', async () => {
      const sessionId = await makeSession({});
      const old = await makeRefreshToken(sessionId, daysAgo(8));
      const recent = await makeRefreshToken(sessionId, daysAgo(6));
      const live = await makeRefreshToken(
        sessionId,
        new Date(now.getTime() + DAY_MS),
      );

      await svc.purgeRefreshTokens(now);

      expect(await exists('refresh_tokens', old)).toBe(false);
      expect(await exists('refresh_tokens', recent)).toBe(true);
      expect(await exists('refresh_tokens', live)).toBe(true);
    });

    it('works through more rows than one batch', async () => {
      const sessionId = await makeSession({});
      const ids = await Promise.all(
        [8, 9, 10].map((d) => makeRefreshToken(sessionId, daysAgo(d))),
      );

      expect(await svc.purgeRefreshTokens(now)).toBeGreaterThanOrEqual(3);

      for (const id of ids) {
        expect(await exists('refresh_tokens', id)).toBe(false);
      }
    });

    it('skips the run while another instance holds the lock', async () => {
      const sessionId = await makeSession({});
      const old = await makeRefreshToken(sessionId, daysAgo(8));

      await orm.em.fork().transactional(async (tx) => {
        await tx
          .getConnection()
          .execute(
            'select pg_advisory_xact_lock(hashtext(?))',
            ['retention:refresh-tokens'],
            'all',
            tx.getTransactionContext(),
          );
        expect(await svc.purgeRefreshTokens(now)).toBe(0);
      });

      expect(await exists('refresh_tokens', old)).toBe(true);
      await svc.purgeRefreshTokens(now);
      expect(await exists('refresh_tokens', old)).toBe(false);
    });
  });

  describe('purgeSessions', () => {
    it('deletes sessions expired longer than the retention period ago, with their tokens', async () => {
      const expired = await makeSession({ absolute_expires_at: daysAgo(31) });
      const token = await makeRefreshToken(expired, daysAgo(31));
      const recentlyExpired = await makeSession({
        absolute_expires_at: daysAgo(29),
      });

      await svc.purgeSessions(now);

      expect(await exists('sessions', expired)).toBe(false);
      expect(await exists('refresh_tokens', token)).toBe(false);
      expect(await exists('sessions', recentlyExpired)).toBe(true);
    });

    it('deletes revoked sessions idle longer than the retention period', async () => {
      const revokedIdle = await makeSession({
        is_active: false,
        last_activity_at: daysAgo(31),
      });
      const revokedRecent = await makeSession({
        is_active: false,
        last_activity_at: daysAgo(29),
      });
      const activeIdle = await makeSession({ last_activity_at: daysAgo(31) });

      await svc.purgeSessions(now);

      expect(await exists('sessions', revokedIdle)).toBe(false);
      expect(await exists('sessions', revokedRecent)).toBe(true);
      expect(await exists('sessions', activeIdle)).toBe(true);
    });
  });

  describe('scrubAiAudit', () => {
    const load = async (ids: { requestId: string; attemptId: string }) => {
      const em = orm.em.fork();
      return {
        req: await em.findOneOrFail(AiRequest, { id: ids.requestId }),
        attempt: await em.findOneOrFail(AiRequestAttempt, {
          id: ids.attemptId,
        }),
      };
    };

    it('nulls prompts and answers older than the retention period, keeping the metadata', async () => {
      const old = await makeAiRequest(daysAgo(31));

      await svc.scrubAiAudit(now);

      const { req, attempt } = await load(old);
      expect(req.prompt).toBeNull();
      expect(req.final_output).toBeNull();
      expect(attempt.raw_response_text).toBeNull();
      expect(attempt.parsed_json).toBeNull();
      expect(req.status).toBe(AiRequestStatus.SUCCESS);
      expect(Number(req.total_cost_usd)).toBeCloseTo(0.01, 6);
      expect(attempt.model).toBe('gpt-4o');
    });

    it('leaves newer requests untouched', async () => {
      const recent = await makeAiRequest(daysAgo(29));

      await svc.scrubAiAudit(now);

      const { req, attempt } = await load(recent);
      expect(req.prompt).not.toBeNull();
      expect(attempt.raw_response_text).not.toBeNull();
    });

    it('leaves PENDING requests to the stale-request sweeper', async () => {
      const pending = await makeAiRequest(daysAgo(31), AiRequestStatus.PENDING);

      await svc.scrubAiAudit(now);

      const { req } = await load(pending);
      expect(req.prompt).not.toBeNull();
    });

    it('works through more rows than one batch', async () => {
      const rows = await Promise.all(
        [31, 32, 33].map((d) => makeAiRequest(daysAgo(d))),
      );

      await svc.scrubAiAudit(now);

      for (const row of rows) {
        const { req, attempt } = await load(row);
        expect(req.prompt).toBeNull();
        expect(attempt.parsed_json).toBeNull();
      }
    });
  });
});
