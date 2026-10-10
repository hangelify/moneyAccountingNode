import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  AiRequest,
  AiRequestStatus,
} from '../../../entities/ai-request.entity';
import {
  AiRequestAttempt,
  AiAttemptStatus,
  AiAttemptErrorCode,
} from '../../../entities/ai-request-attempt.entity';
import { User } from '../../../entities/user.entity';
import { computeCostUsd } from '../pricing';

export interface BeginArgs {
  taskName: string;
  userId?: string;
  requiredCapabilities: string[];
  imageS3Keys?: string[];
  prompt: { messages: Array<{ role: string; text: string }> };
}

export interface BeginAttemptArgs {
  parentId: string;
  providerName: string;
  model: string;
  attemptNumber: number;
}

export interface FinishAttemptArgs {
  attemptId: string;
  status: AiAttemptStatus;
  errorCode?: AiAttemptErrorCode;
  errorMessage?: string;
  rawText?: string;
  parsedJson?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

export interface FinishArgs {
  parentId: string;
  status: AiRequestStatus;
  chosenAttemptId?: string;
  finalOutput?: unknown;
  errorMessage?: string;
}

@Injectable()
export class AiRequestLogger {
  private readonly log = new Logger(AiRequestLogger.name);

  constructor(private readonly em: EntityManager) {}

  /** Sum of `total_cost_usd` of the user's requests created after `since`. */
  async spentSinceUsd(userId: string, since: Date): Promise<number> {
    const rows = await (this.em
      .fork()
      .getConnection()
      .execute(
        'SELECT SUM(total_cost_usd) AS spent FROM ai_requests WHERE user_id = ? AND created_at > ?',
        [userId, since],
      ) as Promise<Array<{ spent: string | null }>>);
    return Number(rows[0]?.spent ?? 0);
  }

  async begin(args: BeginArgs): Promise<{ parentId: string }> {
    const em = this.em.fork();
    const now = new Date();
    const req = em.create(AiRequest, {
      task_name: args.taskName,
      user: args.userId ? em.getReference(User, args.userId) : undefined,
      status: AiRequestStatus.PENDING,
      required_capabilities: args.requiredCapabilities,
      image_s3_keys: args.imageS3Keys,
      prompt: args.prompt,
      created_at: now,
      updated_at: now,
    });
    await em.persist(req).flush();
    return { parentId: req.id };
  }

  async recordImages(parentId: string, keys: string[]): Promise<void> {
    const em = this.em.fork();
    const parent = await em.findOneOrFail(AiRequest, { id: parentId });
    parent.image_s3_keys = keys;
    await em.flush();
  }

  async beginAttempt(
    args: BeginAttemptArgs,
  ): Promise<{ attemptId: string; startedAt: Date }> {
    const em = this.em.fork();
    const parent = em.getReference(AiRequest, args.parentId);
    const startedAt = new Date();
    const a = em.create(AiRequestAttempt, {
      ai_request: parent,
      attempt_number: args.attemptNumber,
      provider_name: args.providerName,
      model: args.model,
      status: AiAttemptStatus.PENDING,
      latency_ms: 0,
      created_at: startedAt,
    });
    await em.persist(a).flush();
    return { attemptId: a.id, startedAt };
  }

  async finishAttempt(args: FinishAttemptArgs): Promise<void> {
    const em = this.em.fork();
    const a = await em.findOneOrFail(AiRequestAttempt, { id: args.attemptId });
    a.status = args.status;
    a.error_code = args.errorCode;
    a.error_message = args.errorMessage;
    a.raw_response_text = args.rawText;
    a.parsed_json = args.parsedJson;
    a.latency_ms = args.latencyMs;
    a.input_tokens = args.inputTokens;
    a.output_tokens = args.outputTokens;

    if (args.inputTokens !== undefined && args.outputTokens !== undefined) {
      const breakdown = computeCostUsd(
        a.model,
        args.inputTokens,
        args.outputTokens,
      );
      if (breakdown) {
        a.input_cost_usd = breakdown.inputUsd;
        a.output_cost_usd = breakdown.outputUsd;
        a.total_cost_usd = breakdown.totalUsd;
      } else {
        this.log.warn(
          `No pricing entry for model '${a.model}' — cost columns left null`,
        );
      }
    }
    await em.flush();
  }

  async finish(args: FinishArgs): Promise<void> {
    const em = this.em.fork();
    const parent = await em.findOneOrFail(
      AiRequest,
      { id: args.parentId },
      { populate: ['attempts'] },
    );
    parent.status = args.status;
    parent.chosen_attempt_id = args.chosenAttemptId;
    parent.final_output = args.finalOutput;
    parent.error_message = args.errorMessage;

    let totalLatency = 0;
    let totalCost: number | null = null;
    for (const a of parent.attempts) {
      totalLatency += a.latency_ms;
      if (a.total_cost_usd != null) {
        totalCost = (totalCost ?? 0) + Number(a.total_cost_usd);
      }
    }
    parent.total_latency_ms = totalLatency;
    parent.total_cost_usd = totalCost ?? undefined;
    await em.flush();
  }

  /**
   * Fails rows still PENDING that were created before `olderThan`: their
   * process died or their audit write failed. Parents get the totals of the
   * attempts that were recorded, so the daily budget still counts them.
   */
  async failStalePending(
    olderThan: Date,
  ): Promise<{ requests: number; attempts: number }> {
    const conn = this.em.fork().getConnection();
    const attempts = await (conn.execute(
      `UPDATE ai_request_attempts
          SET status = 'FAILED', error_code = 'UNKNOWN',
              error_message = 'Outcome never recorded: still PENDING at cleanup'
        WHERE status = 'PENDING' AND created_at < ?`,
      [olderThan],
      'run',
    ) as Promise<{ affectedRows: number }>);
    // A parent with a SUCCESS attempt was answered; only its final write
    // was lost, so it is closed as that success.
    const requests = await (conn.execute(
      `WITH stale AS (
         SELECT r.id,
                (SELECT a.id FROM ai_request_attempts a
                  WHERE a.ai_request_id = r.id AND a.status = 'SUCCESS'
                  ORDER BY a.attempt_number DESC LIMIT 1) AS won
           FROM ai_requests r
          WHERE r.status = 'PENDING' AND r.created_at < ?
       )
       UPDATE ai_requests r
          SET status = (CASE WHEN stale.won IS NULL THEN 'FAILED' ELSE 'SUCCESS' END)::ai_request_status_enum,
              chosen_attempt_id = stale.won,
              final_output = (SELECT a.parsed_json FROM ai_request_attempts a WHERE a.id = stale.won),
              error_message = CASE WHEN stale.won IS NULL
                THEN 'Outcome never recorded: still PENDING at cleanup'
                ELSE 'Closed at cleanup: still PENDING after a successful attempt' END,
              total_latency_ms = (SELECT COALESCE(SUM(a.latency_ms), 0)
                                    FROM ai_request_attempts a WHERE a.ai_request_id = r.id),
              total_cost_usd = (SELECT SUM(a.total_cost_usd)
                                  FROM ai_request_attempts a WHERE a.ai_request_id = r.id),
              updated_at = NOW()
         FROM stale
        WHERE r.id = stale.id`,
      [olderThan],
      'run',
    ) as Promise<{ affectedRows: number }>);
    return {
      requests: requests.affectedRows,
      attempts: attempts.affectedRows,
    };
  }
}
