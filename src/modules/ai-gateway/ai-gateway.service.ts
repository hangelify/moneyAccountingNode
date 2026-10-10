import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiTask } from './types/ai-task';
import type { LlmProvider } from './types/llm-provider';
import { LLM_PROVIDERS } from './types/llm-provider';
import { LlmRequest } from './types/llm-request';
import { ProviderResolver } from './internal/provider-resolver';
import { AiRequestLogger } from './internal/ai-request-logger';
import { AiRequestStatus } from '../../entities/ai-request.entity';
import {
  AiAttemptStatus,
  AiAttemptErrorCode,
} from '../../entities/ai-request-attempt.entity';
import { AiGatewayExhaustedError, NoCapableProviderError } from './errors';
import { classifyError } from './internal/error-classifier';
import { STORAGE_SERVICE } from '../storage/storage.service';
import type { StorageService } from '../storage/storage.service';
import { AI_CALL_CONFIG } from './internal/ai-call-config';
import type { AiCallConfig } from './internal/ai-call-config';
import { DeadlineExceededError, raceAbort } from './internal/retry';

interface Deadline {
  signal: AbortSignal;
  remainingMs(): number;
}

@Injectable()
export class AiGatewayService {
  private readonly log = new Logger(AiGatewayService.name);
  private readonly resolver: ProviderResolver;

  constructor(
    @Inject(LLM_PROVIDERS) providers: LlmProvider[],
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly logger: AiRequestLogger,
    @Inject(AI_CALL_CONFIG) private readonly config: AiCallConfig,
  ) {
    this.resolver = new ProviderResolver(
      providers.filter((p) => p.isConfigured),
    );
  }

  /**
   * Runs the task within `AI_TASK_DEADLINE_MS`. When the deadline fires the
   * in-flight provider call is aborted and no further provider is tried, so
   * the caller gets an error instead of a late result nobody waits for.
   */
  async run<In, Out>(
    task: AiTask<In, Out>,
    input: In,
    opts?: { userId?: string },
  ): Promise<Out> {
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
  ): Promise<Out> {
    // 1. Input validation
    task.inputSchema.parse(input);

    // 2. Build normalized request
    const baseReq = await task.buildRequest(input);

    // 3. Upload any user-message images to S3
    const s3Keys: string[] = [];
    for (const m of baseReq.messages) {
      if (m.role === 'user' && m.images) {
        for (const img of m.images) {
          const { key } = await this.storage.put(img.data, img.mediaType);
          s3Keys.push(key);
        }
      }
    }

    // 4. Compile JSON schema once
    const jsonSchema = z.toJSONSchema(
      task.outputSchema as unknown as Parameters<typeof z.toJSONSchema>[0],
    ) as object;

    // 5. Open audit parent row
    const promptForLog = {
      messages: baseReq.messages.map((m) => ({ role: m.role, text: m.text })),
    };
    const { parentId } = await this.logger.begin({
      taskName: task.name,
      userId: opts?.userId,
      requiredCapabilities: Array.from(task.requiredCapabilities),
      imageS3Keys: s3Keys.length ? s3Keys : undefined,
      prompt: promptForLog,
    });

    // 6. Resolve candidates
    const candidates = this.resolver.candidates(task.requiredCapabilities);
    if (candidates.length === 0) {
      await this.logger.finish({
        parentId,
        status: AiRequestStatus.FAILED,
        errorMessage: 'No capable provider configured',
      });
      throw new NoCapableProviderError(task.name);
    }

    // 7. Loop providers with per-attempt logging and failover
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
      const { attemptId } = await this.logger.beginAttempt({
        parentId,
        providerName: provider.name,
        model,
        attemptNumber: i + 1,
      });
      const t0 = Date.now();
      const req: LlmRequest = {
        ...baseReq,
        jsonSchema,
        modelOverride: model,
      };

      try {
        // Race as well, so a provider that ignores the signal is still bounded.
        const res = await raceAbort(
          provider.complete(req, { signal: deadline.signal }),
          deadline.signal,
        );
        const parsed = task.outputSchema.safeParse(res.json);
        const latencyMs = Date.now() - t0;

        if (!parsed.success) {
          await this.logger.finishAttempt({
            attemptId,
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

        await this.logger.finishAttempt({
          attemptId,
          status: AiAttemptStatus.SUCCESS,
          rawText: res.text,
          parsedJson: parsed.data,
          inputTokens: res.usage?.inputTokens,
          outputTokens: res.usage?.outputTokens,
          latencyMs,
        });
        await this.logger.finish({
          parentId,
          status: AiRequestStatus.SUCCESS,
          chosenAttemptId: attemptId,
          finalOutput: parsed.data,
        });
        return parsed.data;
      } catch (err) {
        const latencyMs = Date.now() - t0;
        const { code, message } = classifyError(err);
        await this.logger.finishAttempt({
          attemptId,
          status: AiAttemptStatus.FAILED,
          errorCode: code,
          errorMessage: message,
          latencyMs,
        });
        lastError = err;
      }
    }

    outOfTime ||= deadline.signal.aborted;
    await this.logger.finish({
      parentId,
      status: AiRequestStatus.FAILED,
      errorMessage: outOfTime
        ? `Task deadline of ${this.config.taskDeadlineMs}ms exceeded`
        : 'All candidate providers failed',
    });
    this.log.warn(
      outOfTime
        ? `AI task '${task.name}' ran out of its ${this.config.taskDeadlineMs}ms deadline (parentId=${parentId})`
        : `AI gateway exhausted all ${candidates.length} candidate provider(s) for task '${task.name}' (parentId=${parentId})`,
    );
    throw new AiGatewayExhaustedError(parentId, lastError);
  }
}
