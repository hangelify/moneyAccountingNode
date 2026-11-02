import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { AiUserQuota } from './ai-user-quota.service';
import { userThrottlerKey } from './guards/user-throttler.guard';
import { AI_USAGE_LIMITS, AiUsageLimits } from './internal/ai-usage-limits';

const DAY_MS = 24 * 60 * 60_000;

describe('AiUserQuota', () => {
  let quota: AiUserQuota;
  let storage: ThrottlerStorage;
  let mod: TestingModule;

  beforeEach(async () => {
    const limits: Partial<AiUsageLimits> = { userPerMinute: 2, userPerDay: 3 };
    mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1_000 }])],
      providers: [AiUserQuota, { provide: AI_USAGE_LIMITS, useValue: limits }],
    }).compile();
    quota = mod.get(AiUserQuota);
    storage = mod.get(ThrottlerStorage);
  });

  // Clears the in-memory storage's 24 h hit timers.
  afterEach(() => mod.close());

  it('reserves up to the daily limit, then refuses with a retry delay', async () => {
    expect((await quota.reserveDaily('u1', 3)).allowed).toBe(true);
    const over = await quota.reserveDaily('u1', 1);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
  });

  it('leaves the counter unchanged when it refuses, so a smaller reservation still fits', async () => {
    expect((await quota.reserveDaily('u1', 1)).allowed).toBe(true);
    const spy = jest.spyOn(storage, 'increment');

    const refused = await quota.reserveDaily('u1', 5);

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSec).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    expect((await quota.reserveDaily('u1', 2)).allowed).toBe(true);
    expect((await quota.reserveDaily('u1', 1)).allowed).toBe(false);
  });

  it('does not block the HTTP guard after a refusal', async () => {
    await quota.reserveDaily('u1', 4);
    const hit = await storage.increment(
      userThrottlerKey('ai-day', 'u1'),
      DAY_MS,
      3,
      DAY_MS,
      'ai-day',
    );
    expect(hit).toMatchObject({ totalHits: 1, isBlocked: false });
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
