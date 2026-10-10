import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { AiRequestLogger } from './ai-request-logger';
import { AI_CALL_CONFIG } from './ai-call-config';
import type { AiCallConfig } from './ai-call-config';

const MIN_STALE_AFTER_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * A row is stale once no live call can still own it: twice the task
 * deadline, and never less than 15 minutes.
 */
export function staleAfterMs(taskDeadlineMs: number): number {
  return Math.max(MIN_STALE_AFTER_MS, 2 * taskDeadlineMs);
}

/**
 * Fails audit rows left PENDING by a crashed process or a failed audit
 * write, at startup and every 15 minutes. Idempotent, so several instances
 * may sweep at once.
 */
@Injectable()
export class AiAuditSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(AiAuditSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly logger: AiRequestLogger,
    @Inject(AI_CALL_CONFIG) private readonly config: AiCallConfig,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: a slow or failing sweep must not hold up startup.
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async sweep(): Promise<void> {
    const cutoff = new Date(
      Date.now() - staleAfterMs(this.config.taskDeadlineMs),
    );
    try {
      const { requests, attempts } = await this.logger.failStalePending(cutoff);
      if (requests || attempts) {
        this.log.warn(
          `Failed ${requests} AI request(s) and ${attempts} attempt(s) left PENDING since before ${cutoff.toISOString()}`,
        );
      }
    } catch (err) {
      this.log.error(
        `Sweeping stale PENDING AI audit rows failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
