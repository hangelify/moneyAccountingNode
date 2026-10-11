import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { Cron } from '@nestjs/schedule';
import { RETENTION_CONFIG } from './retention.env';
import type { RetentionConfig } from './retention.env';
import { runExclusive } from './retention-lock';

export const RETENTION_BATCH_SIZE = Symbol('RETENTION_BATCH_SIZE');

const DAY_MS = 86_400_000;

const PURGE_REFRESH_TOKENS = `
  DELETE FROM refresh_tokens WHERE id IN (
    SELECT id FROM refresh_tokens WHERE expires_at < ? LIMIT ?)`;

// Refresh tokens of a deleted session go with it (ON DELETE CASCADE).
const PURGE_SESSIONS = `
  DELETE FROM sessions WHERE id IN (
    SELECT id FROM sessions
     WHERE absolute_expires_at < ?
        OR (is_active = false AND COALESCE(last_activity_at, created_at) < ?)
     LIMIT ?)`;

// PENDING rows are left to AiAuditSweeper, which may still close them.
const SCRUB_AI_AUDIT = `
  WITH batch AS (
    SELECT id FROM ai_requests
     WHERE prompt IS NOT NULL AND created_at < ? AND status <> 'PENDING'
     ORDER BY created_at
     LIMIT ?
  ), attempts AS (
    UPDATE ai_request_attempts SET raw_response_text = NULL, parsed_json = NULL
     WHERE ai_request_id IN (SELECT id FROM batch)
  )
  UPDATE ai_requests SET prompt = NULL, final_output = NULL, updated_at = NOW()
   WHERE id IN (SELECT id FROM batch)`;

/**
 * Daily data retention: deletes expired auth rows and nulls the raw prompts
 * and answers of old AI requests (their metadata and cost are kept). Each
 * batch runs under an advisory lock, so with several app instances only one
 * does the work.
 */
@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    private readonly em: EntityManager,
    @Inject(RETENTION_CONFIG) private readonly config: RetentionConfig,
    @Inject(RETENTION_BATCH_SIZE) private readonly batchSize: number,
  ) {}

  @Cron('0 4 * * *', { name: 'data-retention', timeZone: 'UTC' })
  async runScheduled(): Promise<void> {
    const now = new Date();
    await this.report('expired refresh token(s)', () =>
      this.purgeRefreshTokens(now),
    );
    await this.report('expired session(s)', () => this.purgeSessions(now));
    await this.report('AI request payload(s)', () => this.scrubAiAudit(now));
  }

  /** Deletes refresh tokens that expired more than the retention period ago. */
  purgeRefreshTokens(now = new Date()): Promise<number> {
    const cutoff = this.cutoff(now, this.config.refreshTokenDays);
    return this.inBatches('refresh-tokens', PURGE_REFRESH_TOKENS, [cutoff]);
  }

  /**
   * Deletes sessions that expired, or were revoked and last used, more than
   * the retention period ago.
   */
  purgeSessions(now = new Date()): Promise<number> {
    const cutoff = this.cutoff(now, this.config.sessionDays);
    return this.inBatches('sessions', PURGE_SESSIONS, [cutoff, cutoff]);
  }

  /** Nulls prompts and answers of AI requests older than the retention period. */
  scrubAiAudit(now = new Date()): Promise<number> {
    const cutoff = this.cutoff(now, this.config.aiAuditRawDays);
    return this.inBatches('ai-audit', SCRUB_AI_AUDIT, [cutoff]);
  }

  private cutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * DAY_MS);
  }

  // One transaction per batch keeps row locks short; a batch that could not
  // take the lock ends the run, as another instance is doing the work.
  private async inBatches(
    name: string,
    sql: string,
    params: unknown[],
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await runExclusive(this.em, name, async (tx) => {
        const res = (await tx
          .getConnection()
          .execute(
            sql,
            [...params, this.batchSize],
            'run',
            tx.getTransactionContext(),
          )) as { affectedRows: number };
        return res.affectedRows;
      });
      if (!batch.ran) return total;
      total += batch.result;
      if (batch.result < this.batchSize) return total;
    }
  }

  private async report(what: string, job: () => Promise<number>) {
    try {
      const count = await job();
      if (count > 0) this.log.log(`Retention: cleared ${count} ${what}`);
    } catch (err) {
      this.log.error(
        `Retention: clearing ${what} failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
