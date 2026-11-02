import { loadAiUsageLimits } from './ai-usage-limits';

describe('loadAiUsageLimits', () => {
  it('applies defaults when the variables are unset or empty', () => {
    expect(loadAiUsageLimits({ AI_MAX_CONCURRENCY: '' })).toEqual({
      userPerMinute: 10,
      userPerDay: 100,
      dailyBudgetUsd: 1,
      maxConcurrency: 4,
    });
  });

  it('reads explicit values', () => {
    expect(
      loadAiUsageLimits({
        AI_USER_LIMIT_PER_MINUTE: '5',
        AI_USER_LIMIT_PER_DAY: '50',
        AI_DAILY_BUDGET_USD: '2.5',
        AI_MAX_CONCURRENCY: '8',
      }),
    ).toEqual({
      userPerMinute: 5,
      userPerDay: 50,
      dailyBudgetUsd: 2.5,
      maxConcurrency: 8,
    });
  });

  it.each([
    ['AI_USER_LIMIT_PER_MINUTE', '0'],
    ['AI_USER_LIMIT_PER_DAY', 'abc'],
    ['AI_MAX_CONCURRENCY', '0'],
    ['AI_MAX_CONCURRENCY', '1.5'],
    ['AI_DAILY_BUDGET_USD', '0'],
    ['AI_DAILY_BUDGET_USD', '-1'],
    ['AI_DAILY_BUDGET_USD', '1e3'],
    ['AI_DAILY_BUDGET_USD', '$5'],
  ])('fails fast naming the variable when %s=%s', (name, value) => {
    expect(() => loadAiUsageLimits({ [name]: value })).toThrow(name);
  });
});
