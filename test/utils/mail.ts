import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  MAIL_SENDER,
  type MailMessage,
  type MailSender,
} from '../../src/modules/mail/mail-sender';

/** Keeps sent emails in memory so specs can read the links in them. */
export class InMemoryMailSender implements MailSender {
  readonly sent: MailMessage[] = [];
  /** While true, send() fails like an unreachable SMTP server. */
  failing = false;

  send(message: MailMessage): Promise<void> {
    if (this.failing) return Promise.reject(new Error('SMTP unreachable'));
    this.sent.push(message);
    return Promise.resolve();
  }
}

export function sentMail(
  app: NestExpressApplication,
  to?: string,
): MailMessage[] {
  const { sent } = app.get<InMemoryMailSender>(MAIL_SENDER);
  return to ? sent.filter((m) => m.to === to) : sent;
}

export function setMailFailing(
  app: NestExpressApplication,
  failing: boolean,
): void {
  app.get<InMemoryMailSender>(MAIL_SENDER).failing = failing;
}

/** The verification token from the latest email to this address. */
export function verificationTokenFor(
  app: NestExpressApplication,
  to: string,
): string {
  const mails = sentMail(app, to);
  const match = /verify-email\?token=([0-9a-f]{64})/.exec(
    mails[mails.length - 1]?.text ?? '',
  );
  if (!match) throw new Error(`No verification email to ${to}`);
  return match[1];
}
