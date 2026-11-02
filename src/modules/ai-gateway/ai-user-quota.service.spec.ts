import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { AiUserQuota } from './ai-user-quota.service';
import { userThrottlerKey } from './guards/user-throttler.guard';
import { AI_USAGE_LIMITS, AiUsageLimits } from './internal/ai-usage-limits';

const DAY_MS = 24 * 60 * 60_000;

describe('AiUserQuota', () => {
  let quota: AiUserQuota;
  let storage: ThrottlerStorage;

  beforeEach(async () => {
    const limits: Partial<AiUsageLimits> = { userPerMinute: 2, userPerDay: 3 };
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1_000 }])],
      providers: [AiUserQuota, { provide: AI_USAGE_LIMITS, useValue: limits }],
    }).compile();
    quota = mod.get(AiUserQuota);
    storage = mod.get(ThrottlerStorage);
  });

  it('reserves up to the daily limit, then refuses with a retry delay', async () => {
    expect((await quota.reserveDaily('u1', 3)).allowed).toBe(true);
    const over = await quota.reserveDaily('u1', 1);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
  });

  it('does not touch storage for a count of zero or less', async () => {
    const spy = jest.spyOn(storage, 'increment');
    expect((await quota.reserveDaily('u1', 0)).allowed).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks takeMinute after the per-minute limit', async () => {
    expect((await quota.takeMinute('u1')).allowed).toBe(true);
    expect((await quota.takeMinute('u1')).allowed).toBe(true);
    const over = await quota.takeMinute('u1');
    expect(over.allowed).toBe(false);
    expect(over.retryAfterMs).toBeGreaterThan(0);
  });

  it('counts per user', async () => {
    await quota.reserveDaily('u1', 3);
    expect((await quota.reserveDaily('u2', 1)).allowed).toBe(true);
  });

  it('shares the counter with the HTTP guard', async () => {
    await storage.increment(
      userThrottlerKey('ai-day', 'u1'),
      DAY_MS,
      3,
      DAY_MS,
      'ai-day',
    );
    expect((await quota.reserveDaily('u1', 3)).allowed).toBe(false);
  });
});
