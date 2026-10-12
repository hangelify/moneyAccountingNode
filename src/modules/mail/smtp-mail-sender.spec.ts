import { createTransport } from 'nodemailer';
import { SmtpMailSender } from './smtp-mail-sender';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('SmtpMailSender', () => {
  it('sends through the configured transport from MAIL_FROM', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    (createTransport as jest.Mock).mockReturnValue({ sendMail });

    const sender = new SmtpMailSender({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'u', pass: 'p' },
      from: 'Money <no-reply@example.com>',
    });
    await sender.send({
      to: 'jane@example.com',
      subject: 'Hi',
      text: 'text',
      html: '<p>html</p>',
    });

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'u', pass: 'p' },
      // Bounded, so an unreachable server cannot stall the request.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Money <no-reply@example.com>',
      to: 'jane@example.com',
      subject: 'Hi',
      text: 'text',
      html: '<p>html</p>',
    });
  });
});
