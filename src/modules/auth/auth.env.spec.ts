import { optionalNonNegativeIntEnv } from './auth.env';

describe('optionalNonNegativeIntEnv', () => {
  const NAME = 'AUTH_ENV_SPEC_VALUE';

  afterEach(() => {
    delete process.env[NAME];
  });

  it('returns the fallback when the variable is unset or empty', () => {
    expect(optionalNonNegativeIntEnv(NAME, 0)).toBe(0);
    process.env[NAME] = '';
    expect(optionalNonNegativeIntEnv(NAME, 7)).toBe(7);
  });

  it('accepts zero and positive integers', () => {
    process.env[NAME] = '0';
    expect(optionalNonNegativeIntEnv(NAME, 5)).toBe(0);
    process.env[NAME] = '30';
    expect(optionalNonNegativeIntEnv(NAME, 0)).toBe(30);
  });

  it.each(['-1', 'abc', '1.5', '10s'])('rejects %p', (raw) => {
    process.env[NAME] = raw;
    expect(() => optionalNonNegativeIntEnv(NAME, 0)).toThrow(NAME);
  });
});
