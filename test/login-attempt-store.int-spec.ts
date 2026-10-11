import Redis from 'ioredis';
import { redisConnectionOptions } from '../src/config/redis';
import {
  LockoutPolicy,
  RedisLoginAttemptStore,
} from '../src/modules/auth/login-lockout/login-attempt.store';

// The e2e apps use the in-memory store; this checks the one production uses.
describe('RedisLoginAttemptStore (integration)', () => {
  let redis: Redis;
  let store: RedisLoginAttemptStore;
  const prefix = `p30-int:${process.pid}:${Date.now()}`;
  const key = (name: string) => `${prefix}:${name}`;
  const policy: LockoutPolicy = {
    maxFailures: 3,
    windowMs: 60_000,
    lockoutMs: 10_000,
    lockoutMaxMs: 30_000,
  };

  beforeAll(() => {
    // Needs the Redis from docker compose / CI; fail fast instead of retrying.
    redis = new Redis({
      ...redisConnectionOptions(),
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    store = new RedisLoginAttemptStore(redis);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    store.onModuleDestroy();
  });

  it('counts attempts and locks on the last allowed one', async () => {
    const [fail, lock] = [key('basic:fail'), key('basic:lock')];

    for (let i = 0; i < 3; i++) {
      expect(await store.reserve(fail, lock, policy)).toBe(0);
    }

    const lockedMs = await store.reserve(fail, lock, policy);
    expect(lockedMs).toBeGreaterThan(9_000);
    expect(lockedMs).toBeLessThanOrEqual(10_000);
    expect(await redis.get(fail)).toBe('3');
  });

  it('starts the window with the first failure and does not extend it', async () => {
    const [fail, lock] = [key('window:fail'), key('window:lock')];
    await store.reserve(fail, lock, policy);
    await redis.pexpire(fail, 5_000);

    await store.reserve(fail, lock, policy);

    expect(await redis.pttl(fail)).toBeLessThanOrEqual(5_000);
  });

  it('lets only maxFailures of many concurrent attempts through', async () => {
    const [fail, lock] = [key('race:fail'), key('race:lock')];

    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.reserve(fail, lock, policy)),
    );

    expect(results.filter((ms) => ms === 0)).toHaveLength(3);
  });

  it('grows the lock up to the cap once it has expired', async () => {
    const [fail, lock] = [key('grow:fail'), key('grow:lock')];
    for (let i = 0; i < 3; i++) await store.reserve(fail, lock, policy);

    const locks: number[] = [];
    for (let i = 0; i < 3; i++) {
      await redis.del(lock); // as if the lock had run out
      await store.reserve(fail, lock, policy);
      locks.push(await redis.pttl(lock));
    }

    expect(locks[0]).toBeGreaterThan(10_000);
    expect(locks[1]).toBeGreaterThan(20_000);
    expect(locks[2]).toBeLessThanOrEqual(30_000);
  });

  it('deletes keys', async () => {
    const [fail, lock] = [key('del:fail'), key('del:lock')];
    for (let i = 0; i < 3; i++) await store.reserve(fail, lock, policy);

    await store.delete(fail, lock);

    expect(await redis.exists(fail, lock)).toBe(0);
  });
});
