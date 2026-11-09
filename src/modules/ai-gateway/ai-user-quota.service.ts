import { Inject, Injectable } from '@nestjs/common';
import {
  InjectThrottlerStorage,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { userThrottlerKey } from './guards/user-throttler.guard';
import { AI_USAGE_LIMITS } from './internal/ai-usage-limits';
import type { AiUsageLimits } from './internal/ai-usage-limits';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAY_THROTTLER = 'ai-day';

/**
 * Adds `count` hits to the counter of ThrottlerStorageRedisService only if
 * they all fit under the limit, in one atomic step. Keys, TTL and block-key
 * semantics match that storage's own script: the hit key expires `ttl` ms
 * after its first hit; the block key exists while the guard refuses. A refusal
 * changes nothing, so it never sets the block key.
 * Returns {allowed (1|0), ms until the caller may try again}.
 */
const RESERVE_SCRIPT = `
local hitKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local count = tonumber(ARGV[3])
local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  return {0, blockTtl}
end
local hitTtl = redis.call('PTTL', hitKey)
local hits = 0
if hitTtl ~= -2 then
  hits = tonumber(redis.call('GET', hitKey) or '0')
end
if hits + count > limit then
  if hitTtl > 0 then
    return {0, hitTtl}
  end
  return {0, ttl}
end
redis.call('INCRBY', hitKey, count)
if redis.call('PTTL', hitKey) <= 0 then
  redis.call('PEXPIRE', hitKey, ttl)
end
return {1, 0}
`;

export interface DailyReservation {
  allowed: boolean;
  retryAfterSec: number;
}

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

  /**
   * Reserves `count` calls of the daily quota, all or nothing: a refusal
   * leaves the counter unchanged and does not block the user, so a smaller
   * request can still pass.
   */
  async reserveDaily(userId: string, count: number): Promise<DailyReservation> {
    if (count <= 0) return { allowed: true, retryAfterSec: 0 };
    const key = userThrottlerKey(DAY_THROTTLER, userId);
    if (this.storage instanceof ThrottlerStorageRedisService) {
      return this.reserveInRedis(this.storage, key, count);
    }
    if (this.storage instanceof ThrottlerStorageService) {
      return this.reserveInMemory(this.storage, key, count);
    }
    throw new Error(
      'AiUserQuota supports only the Redis and in-memory throttler storages',
    );
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

  private async reserveInRedis(
    storage: ThrottlerStorageRedisService,
    key: string,
    count: number,
  ): Promise<DailyReservation> {
    // The key layout of ThrottlerStorageRedisService.increment.
    const hitKey = `{${key}:${DAY_THROTTLER}}:hits`;
    const blockKey = `{${key}:${DAY_THROTTLER}}:blocked`;
    const res = (await storage.redis.eval(
      RESERVE_SCRIPT,
      2,
      hitKey,
      blockKey,
      DAY_MS,
      this.limits.userPerDay,
      count,
    )) as [number, number];
    if (res[0] === 1) return { allowed: true, retryAfterSec: 0 };
    return {
      allowed: false,
      retryAfterSec: Math.max(Math.ceil(res[1] / 1000), 1),
    };
  }

  /**
   * ThrottlerStorageService (tests, a single process): reads the counter,
   * then adds the hits. increment() has no await inside, so the calls below
   * all run synchronously before anything else can touch the counter.
   */
  private async reserveInMemory(
    storage: ThrottlerStorageService,
    key: string,
    count: number,
  ): Promise<DailyReservation> {
    const now = Date.now();
    const record = storage.storage.get(key);
    const blocked = record?.isBlocked && record.blockExpiresAt > now;
    if (record && blocked) {
      return {
        allowed: false,
        retryAfterSec: Math.max(
          Math.ceil((record.blockExpiresAt - now) / 1000),
          1,
        ),
      };
    }
    // An expired block resets the counter on the next increment.
    const hits =
      record && !record.isBlocked
        ? (record.totalHits.get(DAY_THROTTLER) ?? 0)
        : 0;
    if (hits + count > this.limits.userPerDay) {
      const left = record ? Math.ceil((record.expiresAt - now) / 1000) : 0;
      return {
        allowed: false,
        retryAfterSec: Math.max(left > 0 ? left : DAY_MS / 1000, 1),
      };
    }
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < count; i++) {
      calls.push(
        storage.increment(
          key,
          DAY_MS,
          this.limits.userPerDay,
          DAY_MS,
          DAY_THROTTLER,
        ),
      );
    }
    await Promise.all(calls);
    return { allowed: true, retryAfterSec: 0 };
  }
}
