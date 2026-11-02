import { readExchangeRateConfig } from './exchange-rate.env';

describe('readExchangeRateConfig', () => {
  const keys = ['EXCHANGE_RATE_API_URL', 'EXCHANGE_RATE_TIMEOUT_MS'] as const;
  const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('defaults to mdl.md and a 10 s timeout', () => {
    for (const k of keys) delete process.env[k];
    expect(readExchangeRateConfig()).toEqual({
      apiUrl: 'https://mdl.md/api/v1',
      timeoutMs: 10_000,
    });
  });

  it('reads the URL without a trailing slash and a custom timeout', () => {
    process.env.EXCHANGE_RATE_API_URL = 'http://localhost:9999/api/v1/';
    process.env.EXCHANGE_RATE_TIMEOUT_MS = '2500';
    expect(readExchangeRateConfig()).toEqual({
      apiUrl: 'http://localhost:9999/api/v1',
      timeoutMs: 2500,
    });
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'refuses to start with EXCHANGE_RATE_TIMEOUT_MS=%s',
    (value) => {
      process.env.EXCHANGE_RATE_TIMEOUT_MS = value;
      expect(() => readExchangeRateConfig()).toThrow(
        /EXCHANGE_RATE_TIMEOUT_MS/,
      );
    },
  );

  it('refuses to start with a URL that is not http(s)', () => {
    process.env.EXCHANGE_RATE_API_URL = 'ftp://example.com';
    expect(() => readExchangeRateConfig()).toThrow(/EXCHANGE_RATE_API_URL/);
  });
});
