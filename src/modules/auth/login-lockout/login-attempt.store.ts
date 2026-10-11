import { OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';

export const LOGIN_ATTEMPT_STORE = Symbol('LOGIN_ATTEMPT_STORE');

export interface LockoutPolicy {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  lockoutMaxMs: number;
}

/** Login attempt counters shared by every app instance. */
export interface LoginAttemptStore {
  /**
   * Atomically books one attempt before the password is checked: returns the
   * remaining lock in ms when the account is locked, otherwise counts the
   * attempt and returns 0. The attempt that reaches maxFailures sets the lock
   * itself, so concurrent requests cannot all slip in before it.
   */
  reserve(failKey: string, lockKey: string, p: LockoutPolicy): Promise<number>;
  delete(...keys: string[]): Promise<void>;
}

// Same steps as InMemoryLoginAttemptStore.reserve. The window starts with the
// first failure and is not extended by later ones; once locked, the count must
// outlive the lock, or the next lock would not grow.
const RESERVE_SCRIPT = `
local locked = redis.call('PTTL', KEYS[2])
if locked > 0 then return locked end
local count = redis.call('INCR', KEYS[1])
local windowMs = tonumber(ARGV[2])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], windowMs)
end
local max = tonumber(ARGV[1])
if count >= max then
  local lockMs = math.floor(math.min(
    tonumber(ARGV[3]) * 2 ^ (count - max), tonumber(ARGV[4])))
  redis.call('SET', KEYS[2], '1', 'PX', lockMs)
  redis.call('PEXPIRE', KEYS[1], lockMs + windowMs)
end
return 0
`;

const lockMsFor = (count: number, p: LockoutPolicy) =>
  Math.min(p.lockoutMs * 2 ** (count - p.maxFailures), p.lockoutMaxMs);

export class RedisLoginAttemptStore
  implements LoginAttemptStore, OnModuleDestroy
{
  constructor(private readonly redis: Redis) {}

  async reserve(
    failKey: string,
    lockKey: string,
    p: LockoutPolicy,
  ): Promise<number> {
    const result = await this.redis.eval(
      RESERVE_SCRIPT,
      2,
      failKey,
      lockKey,
      p.maxFailures,
      p.windowMs,
      p.lockoutMs,
      p.lockoutMaxMs,
    );
    return Number(result);
  }

  async delete(...keys: string[]): Promise<void> {
    await this.redis.del(...keys);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

/** Process-local store for tests; counters are not shared between instances. */
export class InMemoryLoginAttemptStore implements LoginAttemptStore {
  private readonly entries = new Map<
    string,
    { value: number; expiresAt: number }
  >();

  // Synchronous body, so it is atomic like the Redis script.
  reserve(failKey: string, lockKey: string, p: LockoutPolicy): Promise<number> {
    const now = Date.now();
    const lock = this.live(lockKey, now);
    if (lock) return Promise.resolve(lock.expiresAt - now);

    const fail = this.live(failKey, now) ?? {
      value: 0,
      expiresAt: now + p.windowMs,
    };
    fail.value += 1;
    this.entries.set(failKey, fail);
    if (fail.value >= p.maxFailures) {
      const lockMs = lockMsFor(fail.value, p);
      this.entries.set(lockKey, { value: 1, expiresAt: now + lockMs });
      fail.expiresAt = now + lockMs + p.windowMs;
    }
    return Promise.resolve(0);
  }

  delete(...keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
    return Promise.resolve();
  }

  private live(key: string, now: number) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
