export const MAIL_SENDER = Symbol('MAIL_SENDER');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailSender {
  send(message: MailMessage): Promise<void>;
}
