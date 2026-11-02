import { randomUUID } from 'node:crypto';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { redisConnectionOptions } from '../../config/redis';
import { AiUserQuota } from './ai-user-quota.service';
import { userThrottlerKey } from './guards/user-throttler.guard';
import type { AiUsageLimits } from './internal/ai-usage-limits';

const DAY_MS = 24 * 60 * 60_000;

// The e2e apps count in memory; this checks the Redis storage production uses.
describe('AiUserQuota with ThrottlerStorageRedisService (integration)', () => {
  let storage: ThrottlerStorageRedisService;
  let quota: AiUserQuota;
  const users: string[] = [];
  const newUser = () => {
    const id = `quota-int-${randomUUID()}`;
    users.push(id);
    return id;
  };
  const guardHit = (userId: string) =>
    storage.increment(
      userThrottlerKey('ai-day', userId),
      DAY_MS,
      3,
      DAY_MS,
      'ai-day',
    );

  beforeAll(() => {
    storage = new ThrottlerStorageRedisService({
      ...redisConnectionOptions(),
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    quota = new AiUserQuota(storage, {
      userPerMinute: 10,
      userPerDay: 3,
    } as AiUsageLimits);
  });

  afterAll(async () => {
    for (const u of users) {
      const key = userThrottlerKey('ai-day', u);
      await storage.redis.del(
        `{${key}:ai-day}:hits`,
        `{${key}:ai-day}:blocked`,
      );
    }
    storage.onModuleDestroy();
  });

  it('shares the guard counter and refuses past the limit', async () => {
    const u = newUser();
    await guardHit(u);
    expect((await quota.reserveDaily(u, 2)).allowed).toBe(true);
    const over = await quota.reserveDaily(u, 1);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(DAY_MS / 1000 - 60);
  });

  it('a refusal leaves the counter unchanged and sets no block', async () => {
    const u = newUser();
    await guardHit(u);

    expect((await quota.reserveDaily(u, 5)).allowed).toBe(false);

    const key = userThrottlerKey('ai-day', u);
    expect(await storage.redis.get(`{${key}:ai-day}:hits`)).toBe('1');
    expect(await storage.redis.exists(`{${key}:ai-day}:blocked`)).toBe(0);
    expect((await quota.reserveDaily(u, 2)).allowed).toBe(true);
    expect(await storage.redis.pttl(`{${key}:ai-day}:hits`)).toBeGreaterThan(0);
  });

  it('starts the window on a first reservation', async () => {
    const u = newUser();
    expect((await quota.reserveDaily(u, 3)).allowed).toBe(true);
    const key = userThrottlerKey('ai-day', u);
    const ttl = await storage.redis.pttl(`{${key}:ai-day}:hits`);
    expect(ttl).toBeGreaterThan(DAY_MS - 60_000);
    // The guard's next hit is over the limit, as without the reservation.
    expect((await guardHit(u)).isBlocked).toBe(true);
  });

  it('refuses while the guard has blocked the user', async () => {
    const u = newUser();
    for (let i = 0; i < 4; i++) await guardHit(u);
    const res = await quota.reserveDaily(u, 1);
    expect(res.allowed).toBe(false);
    expect(res.retryAfterSec).toBeGreaterThan(DAY_MS / 1000 - 60);
  });

  it('lets only what fits through of concurrent reservations', async () => {
    const u = newUser();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => quota.reserveDaily(u, 1)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });
});
