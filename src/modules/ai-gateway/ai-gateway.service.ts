import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiTask } from './types/ai-task';
import type { AiTaskResult } from './types/ai-task';
import type { LlmProvider } from './types/llm-provider';
import { LLM_PROVIDERS } from './types/llm-provider';
import { LlmRequest, LlmResponse } from './types/llm-request';
import { ProviderResolver } from './internal/provider-resolver';
import { AiRequestLogger } from './internal/ai-request-logger';
import type { FinishAttemptArgs } from './internal/ai-request-logger';
import { AiRequestStatus } from '../../entities/ai-request.entity';
import {
  AiAttemptStatus,
  AiAttemptErrorCode,
} from '../../entities/ai-request-attempt.entity';
import {
  AiBudgetExceededError,
  AiCapacityExceededError,
  AiGatewayExhaustedError,
  NoCapableProviderError,
} from './errors';
import {
  classifyError,
  InvalidResponseError,
} from './internal/error-classifier';
import { STORAGE_SERVICE } from '../storage/storage.service';
import type { StorageService } from '../storage/storage.service';
import { AI_CALL_CONFIG } from './internal/ai-call-config';
import type { AiCallConfig } from './internal/ai-call-config';
import { DeadlineExceededError, raceAbort } from './internal/retry';
import { AI_USAGE_LIMITS } from './internal/ai-usage-limits';
import type { AiUsageLimits } from './internal/ai-usage-limits';
import { ConcurrencyLimiter } from './internal/concurrency-limiter';
import { toProviderJsonSchema } from './internal/provider-json-schema';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hint for callers refused a slot; a typical AI call takes seconds. */
const CAPACITY_RETRY_AFTER_SEC = 10;

interface Deadline {
  signal: AbortSignal;
  remainingMs(): number;
}

@Injectable()
export class AiGatewayService {
  private readonly log = new Logger(AiGatewayService.name);
  private readonly resolver: ProviderResolver;
  private readonly slots: ConcurrencyLimiter;

  constructor(
    @Inject(LLM_PROVIDERS) providers: LlmProvider[],
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly logger: AiRequestLogger,
    @Inject(AI_CALL_CONFIG) private readonly config: AiCallConfig,
    @Inject(AI_USAGE_LIMITS) private readonly limits: AiUsageLimits,
  ) {
    this.resolver = new ProviderResolver(
      providers.filter((p) => p.isConfigured),
    );
    this.slots = new ConcurrencyLimiter(limits.maxConcurrency);
  }

  /**
   * Runs the task within `AI_TASK_DEADLINE_MS` and returns its output with
   * the `ai_requests` id, so a caller that fails afterwards can still point
   * at the paid-for result. When the deadline fires the
   * in-flight provider call is aborted and no further provider is tried, so
   * the caller gets an error instead of a late result nobody waits for.
   *
   * Refuses up front when the user has spent `AI_DAILY_BUDGET_USD` in the
   * last 24 hours (`AiBudgetExceededError`) or when `AI_MAX_CONCURRENCY`
   * calls already run in this process (`AiCapacityExceededError`).
   */
  async run<In, Out>(
    task: AiTask<In, Out>,
    input: In,
    opts?: { userId?: string },
  ): Promise<AiTaskResult<Out>> {
    if (opts?.userId) await this.assertWithinBudget(opts.userId);
    const release = this.slots.tryAcquire();
    if (!release) {
      throw new AiCapacityExceededError(
        this.limits.maxConcurrency,
        CAPACITY_RETRY_AFTER_SEC,
      );
    }
    try {
      return await this.runWithDeadline(task, input, opts);
    } finally {
      release();
    }
  }

  // Requests still in flight have no cost yet, so concurrent calls of one
  // user can overshoot the budget by what they end up costing.
  private async assertWithinBudget(userId: string): Promise<void> {
    const spent = await this.logger.spentSinceUsd(
      userId,
      new Date(Date.now() - DAY_MS),
    );
    if (spent >= this.limits.dailyBudgetUsd) {
      throw new AiBudgetExceededError(spent, this.limits.dailyBudgetUsd);
    }
  }

  private async runWithDeadline<In, Out>(
    task: AiTask<In, Out>,
    input: In,
    opts: { userId?: string } | undefined,
  ): Promise<AiTaskResult<Out>> {
    const ms = this.config.taskDeadlineMs;
    const endsAt = Date.now() + ms;
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new DeadlineExceededError(ms)),
      ms,
    );
    try {
      return await this.runWithin(task, input, opts, {
        signal: ctrl.signal,
        remainingMs: () => endsAt - Date.now(),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async runWithin<In, Out>(
    task: AiTask<In, Out>,
    input: In,
    opts: { userId?: string } | undefined,
    deadline: Deadline,
  ): Promise<AiTaskResult<Out>> {
    // 1. Input validation
    task.inputSchema.parse(input);

    // 2. Build normalized request
    const baseReq = await task.buildRequest(input);
    const jsonSchema = toProviderJsonSchema(task.outputSchema);

    // 3. Open audit parent row. Nothing is paid for yet, so unlike the later
    // audit writes this one may fail the call: running unaudited would hide
    // its cost from the daily budget.
    const promptForLog = {
      messages: baseReq.messages.map((m) => ({ role: m.role, text: m.text })),
    };
    const { parentId } = await this.logger.begin({
      taskName: task.name,
      userId: opts?.userId,
      requiredCapabilities: Array.from(task.requiredCapabilities),
      prompt: promptForLog,
    });

    // 4. Upload any user-message images to S3
    const s3Keys: string[] = [];
    try {
      for (const m of baseReq.messages) {
        if (m.role === 'user' && m.images) {
          for (const img of m.images) {
            const { key } = await this.storage.put(img.data, img.mediaType);
            s3Keys.push(key);
          }
        }
      }
    } catch (err) {
      if (s3Keys.length) await this.recordImages(parentId, s3Keys);
      await this.audit('finish', () =>
        this.logger.finish({
          parentId,
          status: AiRequestStatus.FAILED,
          errorMessage: `Image upload failed: ${errorText(err)}`,
        }),
      );
      throw err;
    }
    if (s3Keys.length) await this.recordImages(parentId, s3Keys);

    // 5. Resolve candidates
    const candidates = this.resolver.candidates(task.requiredCapabilities);
    if (candidates.length === 0) {
      await this.audit('finish', () =>
        this.logger.finish({
          parentId,
          status: AiRequestStatus.FAILED,
          errorMessage: 'No capable provider configured',
        }),
      );
      throw new NoCapableProviderError(task.name);
    }

    // 6. Loop providers with per-attempt logging and failover
    let lastError: unknown;
    let outOfTime = false;
    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i];
      // The first provider always gets a go; later ones only with enough budget.
      if (i > 0 && deadline.remainingMs() < this.config.minAttemptBudgetMs) {
        outOfTime = true;
        lastError ??= new DeadlineExceededError(this.config.taskDeadlineMs);
        break;
      }
      const model =
        task.modelOverrides?.[provider.name] ?? provider.defaultModel;
      const begun = await this.audit('beginAttempt', () =>
        this.logger.beginAttempt({
          parentId,
          providerName: provider.name,
          model,
          attemptNumber: i + 1,
        }),
      );
      const attemptId = begun?.attemptId;
      const finishAttempt = async (
        args: Omit<FinishAttemptArgs, 'attemptId'>,
      ): Promise<void> => {
        if (!attemptId) return;
        // The usage goes into the log too: if this write fails, it is the
        // only record of what the attempt cost.
        const what = `finishAttempt ${JSON.stringify({
          attemptId,
          model,
          status: args.status,
          inputTokens: args.inputTokens,
          outputTokens: args.outputTokens,
        })}`;
        await this.audit(what, () =>
          this.logger.finishAttempt({ attemptId, ...args }),
        );
      };
      const t0 = Date.now();
      const req: LlmRequest = {
        ...baseReq,
        jsonSchema,
        modelOverride: model,
      };

      // Only the provider call is guarded here: anything after a paid
      // response must not fall into this catch and fail over to the next
      // provider, which would bill the request twice.
      let res: LlmResponse;
      try {
        // Race as well, so a provider that ignores the signal is still bounded.
        res = await raceAbort(
          provider.complete(req, { signal: deadline.signal }),
          deadline.signal,
        );
      } catch (err) {
        const { code, message } = classifyError(err);
        const invalid = err instanceof InvalidResponseError ? err : undefined;
        await finishAttempt({
          status: AiAttemptStatus.FAILED,
          errorCode: code,
          errorMessage: message,
          rawText: invalid?.raw,
          inputTokens: invalid?.usage?.inputTokens,
          outputTokens: invalid?.usage?.outputTokens,
          latencyMs: Date.now() - t0,
        });
        lastError = err;
        continue;
      }

      const parsed = task.outputSchema.safeParse(res.json);
      const latencyMs = Date.now() - t0;
      if (!parsed.success) {
        await finishAttempt({
          status: AiAttemptStatus.FAILED,
          errorCode: AiAttemptErrorCode.SCHEMA_INVALID,
          errorMessage: parsed.error.message,
          rawText: res.text,
          inputTokens: res.usage?.inputTokens,
          outputTokens: res.usage?.outputTokens,
          latencyMs,
        });
        lastError = parsed.error;
        continue;
      }

      await finishAttempt({
        status: AiAttemptStatus.SUCCESS,
        rawText: res.text,
        parsedJson: parsed.data,
        inputTokens: res.usage?.inputTokens,
        outputTokens: res.usage?.outputTokens,
        latencyMs,
      });
      await this.audit('finish', () =>
        this.logger.finish({
          parentId,
          status: AiRequestStatus.SUCCESS,
          chosenAttemptId: attemptId,
          finalOutput: parsed.data,
        }),
      );
      return { data: parsed.data, requestId: parentId };
    }

    outOfTime ||= deadline.signal.aborted;
    await this.audit('finish', () =>
      this.logger.finish({
        parentId,
        status: AiRequestStatus.FAILED,
        errorMessage: outOfTime
          ? `Task deadline of ${this.config.taskDeadlineMs}ms exceeded`
          : 'All candidate providers failed',
      }),
    );
    this.log.warn(
      outOfTime
        ? `AI task '${task.name}' ran out of its ${this.config.taskDeadlineMs}ms deadline (parentId=${parentId})`
        : `AI gateway exhausted all ${candidates.length} candidate provider(s) for task '${task.name}' (parentId=${parentId})`,
    );
    throw new AiGatewayExhaustedError(parentId, lastError);
  }

  private async recordImages(parentId: string, keys: string[]): Promise<void> {
    await this.audit('recordImages', () =>
      this.logger.recordImages(parentId, keys),
    );
  }

  /**
   * Runs an audit write without letting it fail the call: a DB error after a
   * paid response must neither discard the result nor surface as a 500.
   * Rows left PENDING this way are closed by `AiAuditSweeper`.
   */
  private async audit<T>(
    what: string,
    write: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await write();
    } catch (err) {
      this.log.error(
        `AI audit write '${what}' failed: ${errorText(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return undefined;
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
