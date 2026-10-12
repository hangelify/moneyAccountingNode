import type { MailMessage } from '../../mail/mail-sender';

// No user input in the body: anyone can register any address, so a name
// placed here would let them send their own text from our domain.
export function buildVerificationEmail(params: {
  link: string;
  ttlHours: number;
}): Omit<MailMessage, 'to'> {
  const { link, ttlHours } = params;
  const expiry = `The link expires in ${ttlHours} hours. If you did not create an account, ignore this email.`;
  return {
    subject: 'Confirm your email address',
    text: [
      'Hi,',
      '',
      'Please confirm your email address by opening this link:',
      link,
      '',
      expiry,
    ].join('\n'),
    html:
      '<p>Hi,</p>' +
      '<p>Please confirm your email address:</p>' +
      `<p><a href="${link}">Confirm email address</a></p>` +
      `<p>${expiry}</p>`,
  };
}
