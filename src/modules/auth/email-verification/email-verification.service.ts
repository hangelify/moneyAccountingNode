import { createHash, randomBytes } from 'crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, type FilterQuery } from '@mikro-orm/core';
import { User } from '../../../entities/user.entity';
import { MAIL_SENDER, type MailSender } from '../../mail/mail-sender';
import {
  EMAIL_VERIFICATION_CONFIG,
  type EmailVerificationConfig,
} from './email-verification.env';
import { buildVerificationEmail } from './verification-email';

const HOUR_MS = 60 * 60 * 1000;
/** Minimum time between two verification emails to one user. */
const RESEND_COOLDOWN_MS = 60_000;

type Recipient = Pick<User, 'id' | 'email'>;

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

// SMTP error messages may quote the recipient address; only the code is
// logged.
function describeMailError(err: unknown): string {
  if (err && typeof err === 'object') {
    const { code, responseCode } = err as {
      code?: unknown;
      responseCode?: unknown;
    };
    if (code || responseCode) {
      return [code, responseCode].filter(Boolean).join(' ');
    }
  }
  return err instanceof Error ? err.name : 'unknown error';
}

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    @Inject(EMAIL_VERIFICATION_CONFIG)
    private readonly config: EmailVerificationConfig,
  ) {}

  /**
   * Used right after registration: a failure is only logged, the user can
   * ask for another email.
   */
  async issueAndSend(user: Recipient): Promise<void> {
    try {
      await this.issueAndSendOrThrow(user, { cooldown: false });
    } catch (err) {
      this.logger.error(
        `Failed to send the verification email to user ${user.id}: ${describeMailError(err)}`,
      );
    }
  }

  /** Marks the token owner verified and returns their id. */
  async verify(rawToken: string): Promise<string> {
    const tokenHash = hashToken(rawToken);
    const now = new Date();
    const user = await this.userRepository.findOne(
      {
        email_verification_token_hash: tokenHash,
        email_verification_expires_at: { $gt: now },
        deleted_at: null,
      },
      { fields: ['id'] },
    );
    // Conditional on the hash: of two concurrent requests with one token,
    // only one spends it.
    const updated = user
      ? await this.userRepository.nativeUpdate(
          { id: user.id, email_verification_token_hash: tokenHash },
          {
            email_verified_at: now,
            email_verification_token_hash: null,
            email_verification_expires_at: null,
            email_verification_sent_at: null,
          },
        )
      : 0;
    if (!user || updated === 0) {
      throw new BadRequestException('Invalid or expired verification token');
    }
    return user.id;
  }

  /** Sends a new link; the previous one stops working. */
  async resend(userId: string): Promise<'sent' | 'already_verified'> {
    const user = await this.userRepository.findOne(
      { id: userId, deleted_at: null },
      { fields: ['id', 'email'] },
    );
    if (!user) throw new NotFoundException('User not found');

    let issued: boolean;
    try {
      issued = await this.issueAndSendOrThrow(user, { cooldown: true });
    } catch (err) {
      this.logger.error(
        `Failed to resend the verification email to user ${user.id}: ${describeMailError(err)}`,
      );
      throw new ServiceUnavailableException(
        'Could not send the verification email, try again later',
      );
    }
    if (issued) return 'sent';

    const current = await this.userRepository.findOne(
      { id: userId },
      { fields: ['email_verified_at'] },
    );
    if (current?.email_verified_at) return 'already_verified';
    throw new HttpException(
      'A verification email was sent less than a minute ago',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Returns false, sending nothing, when the user is already verified or,
   * with `cooldown`, was emailed less than a minute ago. Both are checked in
   * the update itself, so concurrent calls cannot both pass.
   */
  private async issueAndSendOrThrow(
    user: Recipient,
    { cooldown }: { cooldown: boolean },
  ): Promise<boolean> {
    const now = new Date();
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);

    const where: FilterQuery<User> = { id: user.id, email_verified_at: null };
    if (cooldown) {
      where.$or = [
        { email_verification_sent_at: null },
        {
          email_verification_sent_at: {
            $lte: new Date(now.getTime() - RESEND_COOLDOWN_MS),
          },
        },
      ];
    }
    const updated = await this.userRepository.nativeUpdate(where, {
      email_verification_token_hash: tokenHash,
      email_verification_expires_at: new Date(
        now.getTime() + this.config.ttlHours * HOUR_MS,
      ),
      email_verification_sent_at: now,
    });
    if (updated === 0) return false;

    const link = `${this.config.frontendUrl}/verify-email?token=${rawToken}`;
    try {
      await this.mail.send({
        to: user.email,
        ...buildVerificationEmail({ link, ttlHours: this.config.ttlHours }),
      });
    } catch (err) {
      // The link never reached the user: drop it so the cooldown does not
      // block an immediate retry.
      await this.userRepository
        .nativeUpdate(
          { id: user.id, email_verification_token_hash: tokenHash },
          {
            email_verification_token_hash: null,
            email_verification_expires_at: null,
            email_verification_sent_at: null,
          },
        )
        .catch(() => undefined);
      throw err;
    }
    return true;
  }
}
