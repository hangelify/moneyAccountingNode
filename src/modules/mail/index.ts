// Public API of the mail module.
// Other modules import from here, never from files inside the module.
// Order matters: leaf files first, the Nest module last, so a module that
// imports this barrel back during loading still finds the leaf exports.

export type { MailMessage, MailSender } from './mail-sender';
export { MAIL_SENDER } from './mail-sender';
export { MailModule } from './mail.module';
