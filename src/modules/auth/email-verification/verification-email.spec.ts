import { buildVerificationEmail } from './verification-email';

describe('buildVerificationEmail', () => {
  const link = 'https://app.example.com/verify-email?token=abc';

  it('puts the link into both bodies', () => {
    const mail = buildVerificationEmail({ link, ttlHours: 24 });
    expect(mail.subject).toBe('Confirm your email address');
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.text).toContain('24 hours');
  });
});
