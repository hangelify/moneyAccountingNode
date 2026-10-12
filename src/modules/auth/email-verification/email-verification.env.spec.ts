import { readEmailVerificationConfig } from './email-verification.env';

describe('readEmailVerificationConfig', () => {
  const base = { FRONTEND_URL: 'https://app.example.com' };

  it('defaults the token TTL to 24 hours', () => {
    expect(readEmailVerificationConfig(base)).toEqual({
      frontendUrl: 'https://app.example.com',
      ttlHours: 24,
    });
  });

  it('reads EMAIL_VERIFICATION_TTL_HOURS', () => {
    expect(
      readEmailVerificationConfig({
        ...base,
        EMAIL_VERIFICATION_TTL_HOURS: '48',
      }).ttlHours,
    ).toBe(48);
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'rejects EMAIL_VERIFICATION_TTL_HOURS=%s',
    (value) => {
      expect(() =>
        readEmailVerificationConfig({
          ...base,
          EMAIL_VERIFICATION_TTL_HOURS: value,
        }),
      ).toThrow('EMAIL_VERIFICATION_TTL_HOURS');
    },
  );

  it('requires FRONTEND_URL', () => {
    expect(() => readEmailVerificationConfig({})).toThrow('FRONTEND_URL');
  });
});
