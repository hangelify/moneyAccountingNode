import { createHash } from 'crypto';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import type { EntityRepository } from '@mikro-orm/core';
import type { User } from '../../../entities/user.entity';
import type { MailMessage, MailSender } from '../../mail/mail-sender';
import { EmailVerificationService } from './email-verification.service';

const NOW = new Date('2026-10-12T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function makeService() {
  const sent: MailMessage[] = [];
  const mail: MailSender = {
    send: jest.fn((m: MailMessage) => {
      sent.push(m);
      return Promise.resolve();
    }),
  };
  const repo = {
    findOne: jest.fn(),
    nativeUpdate: jest.fn().mockResolvedValue(1),
  };
  const service = new EmailVerificationService(
    repo as unknown as EntityRepository<User>,
    mail,
    { frontendUrl: 'https://app.example.com', ttlHours: 24 },
  );
  return { service, repo, mail, sent };
}

function tokenFrom(message: MailMessage): string {
  const match = /verify-email\?token=([0-9a-f]+)/.exec(message.text);
  if (!match) throw new Error('no token in the email');
  return match[1];
}

const jane = { id: 'u1', email: 'jane@example.com' };
const issued = (token: string) => ({
  email_verification_token_hash: sha256(token),
  email_verification_expires_at: new Date(NOW.getTime() + 24 * HOUR),
  email_verification_sent_at: NOW,
});

describe('EmailVerificationService', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  describe('issueAndSend', () => {
    it('stores only the hash of the mailed token, with the TTL', async () => {
      const { service, repo, sent } = makeService();

      await service.issueAndSend(jane);

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('jane@example.com');
      expect(sent[0].text).toContain(
        'https://app.example.com/verify-email?token=',
      );
      const token = tokenFrom(sent[0]);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(repo.nativeUpdate).toHaveBeenCalledWith(
        { id: 'u1', email_verified_at: null },
        issued(token),
      );
    });

    it('does not throw when the email cannot be sent, and drops the unsent token', async () => {
      const { service, repo, mail } = makeService();
      (mail.send as jest.Mock).mockRejectedValue(new Error('SMTP down'));

      await expect(service.issueAndSend(jane)).resolves.toBeUndefined();

      const [, stored] = repo.nativeUpdate.mock.calls[0] as [
        unknown,
        { email_verification_token_hash: string },
      ];
      expect(repo.nativeUpdate).toHaveBeenLastCalledWith(
        {
          id: 'u1',
          email_verification_token_hash: stored.email_verification_token_hash,
        },
        {
          email_verification_token_hash: null,
          email_verification_expires_at: null,
          email_verification_sent_at: null,
        },
      );
    });
  });

  describe('verify', () => {
    it('marks the owner verified and clears the token', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({ id: 'u1' });

      await expect(service.verify('a'.repeat(64))).resolves.toBe('u1');

      expect(repo.findOne).toHaveBeenCalledWith(
        {
          email_verification_token_hash: sha256('a'.repeat(64)),
          email_verification_expires_at: { $gt: NOW },
          deleted_at: null,
        },
        { fields: ['id'] },
      );
      expect(repo.nativeUpdate).toHaveBeenCalledWith(
        { id: 'u1', email_verification_token_hash: sha256('a'.repeat(64)) },
        {
          email_verified_at: NOW,
          email_verification_token_hash: null,
          email_verification_expires_at: null,
          email_verification_sent_at: null,
        },
      );
    });

    it('rejects an unknown, used or expired token', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue(null);

      await expect(service.verify('b'.repeat(64))).rejects.toThrow(
        new BadRequestException('Invalid or expired verification token'),
      );
      expect(repo.nativeUpdate).not.toHaveBeenCalled();
    });

    it('rejects a token spent by a concurrent request', async () => {
      const { service, repo } = makeService();
      repo.findOne.mockResolvedValue({ id: 'u1' });
      repo.nativeUpdate.mockResolvedValue(0);

      await expect(service.verify('c'.repeat(64))).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('resend', () => {
    it('issues a token only to an unverified user outside the cooldown', async () => {
      const { service, repo, sent } = makeService();
      repo.findOne.mockResolvedValue(jane);

      await expect(service.resend('u1')).resolves.toBe('sent');

      expect(sent).toHaveLength(1);
      expect(repo.nativeUpdate).toHaveBeenCalledWith(
        {
          id: 'u1',
          email_verified_at: null,
          $or: [
            { email_verification_sent_at: null },
            {
              email_verification_sent_at: {
                $lte: new Date(NOW.getTime() - 60_000),
              },
            },
          ],
        },
        issued(tokenFrom(sent[0])),
      );
    });

    it('sends nothing to a verified user', async () => {
      const { service, repo, sent } = makeService();
      repo.findOne
        .mockResolvedValueOnce(jane)
        .mockResolvedValueOnce({ email_verified_at: NOW });
      repo.nativeUpdate.mockResolvedValue(0);

      await expect(service.resend('u1')).resolves.toBe('already_verified');
      expect(sent).toHaveLength(0);
    });

    it('answers 429 within a minute of the last email', async () => {
      const { service, repo, sent } = makeService();
      repo.findOne
        .mockResolvedValueOnce(jane)
        .mockResolvedValueOnce({ email_verified_at: null });
      repo.nativeUpdate.mockResolvedValue(0);

      const err = await service.resend('u1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(sent).toHaveLength(0);
    });

    it('reports a mail failure and leaves no cooldown behind', async () => {
      const { service, repo, mail } = makeService();
      repo.findOne.mockResolvedValue(jane);
      (mail.send as jest.Mock).mockRejectedValue(new Error('SMTP down'));

      const err = await service.resend('u1').catch((e: unknown) => e);
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
      expect(repo.nativeUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'u1' }),
        expect.objectContaining({ email_verification_sent_at: null }),
      );
    });
  });
});
