import { assertJwtSecrets, optionalNonNegativeIntEnv } from './auth.env';

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

describe('assertJwtSecrets', () => {
  const KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const;
  const saved = KEYS.map((k) => process.env[k]);
  const strong = (c: string) => c.repeat(32);

  afterEach(() => {
    KEYS.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  });

  it('accepts two distinct secrets of at least 32 bytes', () => {
    process.env.JWT_SECRET = strong('a');
    process.env.JWT_REFRESH_SECRET = strong('b');
    expect(() => assertJwtSecrets()).not.toThrow();
  });

  it.each(KEYS)('rejects %s shorter than 32 bytes', (key) => {
    process.env.JWT_SECRET = strong('a');
    process.env.JWT_REFRESH_SECRET = strong('b');
    process.env[key] = 'x'.repeat(31);
    expect(() => assertJwtSecrets()).toThrow(key);
  });

  it('counts bytes, not characters', () => {
    // 16 two-byte characters: 32 bytes.
    process.env.JWT_SECRET = 'ж'.repeat(16);
    process.env.JWT_REFRESH_SECRET = strong('b');
    expect(() => assertJwtSecrets()).not.toThrow();
  });

  it('rejects equal access and refresh secrets', () => {
    process.env.JWT_SECRET = strong('a');
    process.env.JWT_REFRESH_SECRET = strong('a');
    expect(() => assertJwtSecrets()).toThrow(/must differ/);
  });

  it('rejects a missing secret', () => {
    process.env.JWT_SECRET = strong('a');
    delete process.env.JWT_REFRESH_SECRET;
    expect(() => assertJwtSecrets()).toThrow('JWT_REFRESH_SECRET');
  });
});
