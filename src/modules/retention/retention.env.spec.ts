import { readRetentionConfig } from './retention.env';

const VARS = [
  'REFRESH_TOKEN_RETENTION_DAYS',
  'SESSION_RETENTION_DAYS',
  'AI_AUDIT_RAW_RETENTION_DAYS',
] as const;

describe('readRetentionConfig', () => {
  const original = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  afterEach(() => {
    for (const v of VARS) {
      if (original[v] === undefined) delete process.env[v];
      else process.env[v] = original[v];
    }
  });

  it('defaults to 7 / 30 / 30 days', () => {
    for (const v of VARS) delete process.env[v];
    expect(readRetentionConfig()).toEqual({
      refreshTokenDays: 7,
      sessionDays: 30,
      aiAuditRawDays: 30,
    });
  });

  it('reads positive whole numbers of days', () => {
    process.env.REFRESH_TOKEN_RETENTION_DAYS = '14';
    process.env.SESSION_RETENTION_DAYS = '60';
    process.env.AI_AUDIT_RAW_RETENTION_DAYS = '90';
    expect(readRetentionConfig()).toEqual({
      refreshTokenDays: 14,
      sessionDays: 60,
      aiAuditRawDays: 90,
    });
  });

  describe.each(VARS)('%s', (name) => {
    it.each(['0', '-1', '1.5', 'abc'])('refuses to start with %s', (value) => {
      process.env[name] = value;
      expect(() => readRetentionConfig()).toThrow(new RegExp(name));
    });
  });
});
