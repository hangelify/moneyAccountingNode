import { readMailConfig } from './mail.env';

describe('readMailConfig', () => {
  const base = {
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    MAIL_FROM: 'Money <no-reply@example.com>',
  };

  it('reads the SMTP settings', () => {
    expect(readMailConfig({ ...base, SMTP_SECURE: 'true' })).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      auth: undefined,
      from: 'Money <no-reply@example.com>',
    });
  });

  it('defaults SMTP_SECURE to false', () => {
    expect(readMailConfig(base).secure).toBe(false);
  });

  it('passes credentials when both user and password are set', () => {
    expect(
      readMailConfig({ ...base, SMTP_USER: 'u', SMTP_PASS: 'p' }).auth,
    ).toEqual({ user: 'u', pass: 'p' });
  });

  it.each(['SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM'])(
    'throws when %s is missing',
    (name) => {
      const env: NodeJS.ProcessEnv = { ...base };
      delete env[name];
      expect(() => readMailConfig(env)).toThrow(name);
    },
  );

  it('throws on a non-numeric SMTP_PORT', () => {
    expect(() => readMailConfig({ ...base, SMTP_PORT: 'abc' })).toThrow(
      'SMTP_PORT',
    );
  });

  it('throws on an SMTP_SECURE other than true or false', () => {
    expect(() => readMailConfig({ ...base, SMTP_SECURE: 'yes' })).toThrow(
      'SMTP_SECURE',
    );
  });

  it('throws when only one of SMTP_USER and SMTP_PASS is set', () => {
    expect(() => readMailConfig({ ...base, SMTP_USER: 'u' })).toThrow(
      'SMTP_USER and SMTP_PASS',
    );
  });
});
