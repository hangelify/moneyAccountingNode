import { Inject, Injectable } from '@nestjs/common';
import { InjectThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { userThrottlerKey } from './guards/user-throttler.guard';
import { AI_USAGE_LIMITS } from './internal/ai-usage-limits';
import type { AiUsageLimits } from './internal/ai-usage-limits';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Counts AI calls against the same per-user counters as UserThrottlerGuard,
 * for callers outside HTTP (a batch upload, the background worker).
 */
@Injectable()
export class AiUserQuota {
  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    @Inject(AI_USAGE_LIMITS) private readonly limits: AiUsageLimits,
  ) {}

  /** Reserves `count` calls of the daily quota; refuses once the limit is exceeded. */
  async reserveDaily(
    userId: string,
    count: number,
  ): Promise<{ allowed: boolean; retryAfterSec: number }> {
    if (count <= 0) return { allowed: true, retryAfterSec: 0 };
    const key = userThrottlerKey('ai-day', userId);
    let last: Awaited<ReturnType<ThrottlerStorage['increment']>> | undefined;
    for (let i = 0; i < count; i++) {
      last = await this.storage.increment(
        key,
        DAY_MS,
        this.limits.userPerDay,
        DAY_MS,
        'ai-day',
      );
    }
    if (last!.totalHits <= this.limits.userPerDay) {
      return { allowed: true, retryAfterSec: 0 };
    }
    // Storage reports both in seconds.
    return {
      allowed: false,
      retryAfterSec: Math.max(last!.timeToBlockExpire, last!.timeToExpire, 1),
    };
  }

  /** Takes one call of the per-minute quota. */
  async takeMinute(
    userId: string,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const r = await this.storage.increment(
      userThrottlerKey('ai-minute', userId),
      MINUTE_MS,
      this.limits.userPerMinute,
      MINUTE_MS,
      'ai-minute',
    );
    if (r.totalHits <= this.limits.userPerMinute) {
      return { allowed: true, retryAfterMs: 0 };
    }
    return {
      allowed: false,
      retryAfterMs: Math.max(r.timeToBlockExpire, r.timeToExpire, 1) * 1000,
    };
  }
}
