import { createTransport, type Transporter } from 'nodemailer';
import type { MailConfig } from './mail.env';
import type { MailMessage, MailSender } from './mail-sender';

export class SmtpMailSender implements MailSender {
  private readonly transport: Transporter;

  constructor(private readonly config: MailConfig) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth,
      // Bounded, so an unreachable server cannot stall the request.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.from, ...message });
  }
}
