import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import {
  createTestApp,
  registerUser,
  resetThrottling,
  type TestUser,
} from './utils/app';
import { sentMail, setMailFailing, verificationTokenFor } from './utils/mail';
import type { InviteResponseDto } from '../src/modules/household/dto/household-response.dto';
import type { UserProfileDto } from '../src/modules/user/dto/user-profile.dto';

describe('Email verification (e2e)', () => {
  let app: NestExpressApplication;

  const http = () => request(app.getHttpServer());
  const auth = (user: TestUser) => `Bearer ${user.accessToken}`;

  const verify = (token: string) =>
    http().post('/auth/verify-email').send({ token });
  const resend = (user: TestUser) =>
    http().post('/auth/resend-verification').set('Authorization', auth(user));

  async function isVerified(user: TestUser): Promise<boolean> {
    const res = await http()
      .get('/auth/me')
      .set('Authorization', auth(user))
      .expect(200);
    return (res.body as UserProfileDto).email_verified;
  }

  // Moves the last email back in time, past the resend cooldown.
  async function backdateLastEmail(user: TestUser): Promise<void> {
    await app
      .get(MikroORM)
      .em.getConnection()
      .execute(
        `update users set email_verification_sent_at = email_verification_sent_at - interval '2 minutes' where email = ?`,
        [user.email],
      );
  }

  async function expireToken(user: TestUser): Promise<void> {
    await app
      .get(MikroORM)
      .em.getConnection()
      .execute(
        `update users set email_verification_expires_at = now() - interval '1 second' where email = ?`,
        [user.email],
      );
  }

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(() => resetThrottling(app));

  afterAll(async () => {
    await app.close();
  });

  it('sends a verification link on registration and starts unverified', async () => {
    const jane = await registerUser(app, 'jane', { verified: false });

    const mails = sentMail(app, jane.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain(
      'http://frontend.e2e.test/verify-email?token=',
    );
    expect(await isVerified(jane)).toBe(false);
  });

  it('verifies the email with the token from the link, once', async () => {
    const jane = await registerUser(app, 'jane', { verified: false });
    const token = verificationTokenFor(app, jane.email);

    await verify(token).expect(204);
    expect(await isVerified(jane)).toBe(true);

    await verify(token)
      .expect(400)
      .expect((res) =>
        expect((res.body as { message: string }).message).toBe(
          'Invalid or expired verification token',
        ),
      );
  });

  it('rejects an unknown token (400)', async () => {
    await verify('f'.repeat(64)).expect(400);
  });

  it('rejects a token that is not 64 hex characters (400)', async () => {
    await verify('not-a-token').expect(400);
  });

  it('rejects an expired token (400)', async () => {
    const jane = await registerUser(app, 'jane', { verified: false });
    const token = verificationTokenFor(app, jane.email);
    await expireToken(jane);

    await verify(token).expect(400);
    expect(await isVerified(jane)).toBe(false);
  });

  describe('when the email cannot be sent', () => {
    afterEach(() => setMailFailing(app, false));

    it('still registers, and the user can ask again right away', async () => {
      setMailFailing(app, true);
      const jane = await registerUser(app, 'jane', { verified: false });
      expect(sentMail(app, jane.email)).toHaveLength(0);

      await resend(jane).expect(503);

      setMailFailing(app, false);
      await resend(jane).expect(204);
      await verify(verificationTokenFor(app, jane.email)).expect(204);
    });
  });

  describe('resend-verification', () => {
    it('requires authentication (401)', async () => {
      await http().post('/auth/resend-verification').expect(401);
    });

    it('sends a new link that replaces the previous one', async () => {
      const jane = await registerUser(app, 'jane', { verified: false });
      const first = verificationTokenFor(app, jane.email);
      await backdateLastEmail(jane);

      await resend(jane).expect(204);

      expect(sentMail(app, jane.email)).toHaveLength(2);
      const second = verificationTokenFor(app, jane.email);
      expect(second).not.toBe(first);
      await verify(first).expect(400);
      await verify(second).expect(204);
    });

    it('answers 429 right after the previous email', async () => {
      const jane = await registerUser(app, 'jane', { verified: false });

      await resend(jane).expect(429);
      expect(sentMail(app, jane.email)).toHaveLength(1);
    });

    it('sends nothing to a verified user', async () => {
      const jane = await registerUser(app, 'jane');
      const before = sentMail(app, jane.email).length;

      await resend(jane).expect(204);
      expect(sentMail(app, jane.email)).toHaveLength(before);
    });
  });

  describe('household invites', () => {
    const invite = (by: TestUser, email: string) =>
      http()
        .post(`/households/${by.householdId}/invites`)
        .set('Authorization', auth(by))
        .send({ email });
    const accept = (user: TestUser, token: string) =>
      http()
        .post('/households/invites/accept')
        .set('Authorization', auth(user))
        .send({ token });

    it('cannot be accepted until the invitee verifies the email', async () => {
      const owner = await registerUser(app, 'owner');
      const jane = await registerUser(app, 'jane', { verified: false });
      const res = await invite(owner, jane.email).expect(201);
      const { token } = res.body as InviteResponseDto;

      await accept(jane, token)
        .expect(403)
        .expect((r) =>
          expect((r.body as { message: string }).message).toBe(
            'Email address is not verified',
          ),
        );

      await verify(verificationTokenFor(app, jane.email)).expect(204);
      await accept(jane, token).expect(204);
    });

    it('cannot be created by an unverified owner', async () => {
      const owner = await registerUser(app, 'owner', { verified: false });

      await invite(owner, 'someone@example.com').expect(403);
    });
  });
});
