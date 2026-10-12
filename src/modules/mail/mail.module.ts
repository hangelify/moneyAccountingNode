import { Global, Module } from '@nestjs/common';
import { MAIL_SENDER } from './mail-sender';
import { readMailConfig } from './mail.env';
import { SmtpMailSender } from './smtp-mail-sender';

@Global()
@Module({
  providers: [
    {
      provide: MAIL_SENDER,
      // Env is read at bootstrap, not when this file is imported.
      useFactory: () => new SmtpMailSender(readMailConfig()),
    },
  ],
  exports: [MAIL_SENDER],
})
export class MailModule {}
