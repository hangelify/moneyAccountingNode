import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { MikroORM } from '@mikro-orm/core';
import request from 'supertest';
import {
  createTestApp,
  registerUser,
  resetThrottling,
  TestUser,
} from './utils/app';
import { HouseholdInvite } from '../src/entities/household-invite.entity';
import type { JwtPayload } from '../src/modules/auth/types/jwt-payload.interface';
import type {
  HouseholdDetailResponseDto,
  InviteListItemDto,
  InviteResponseDto,
} from '../src/modules/household/dto/household-response.dto';

// An invite is bound to the invitee's email, carries its token in the request
// body, can be revoked by the owner, and is only spent when the invitee
// actually joins.
describe('Household invites (e2e)', () => {
  let app: NestExpressApplication;
  let owner: TestUser;

  const http = () => request(app.getHttpServer());
  const auth = (user: TestUser) => `Bearer ${user.accessToken}`;

  async function invite(email: string, by = owner): Promise<InviteResponseDto> {
    const res = await http()
      .post(`/households/${by.householdId}/invites`)
      .set('Authorization', auth(by))
      .send({ email })
      .expect(201);
    return res.body as InviteResponseDto;
  }

  const accept = (user: TestUser, token: string) =>
    http()
      .post('/households/invites/accept')
      .set('Authorization', auth(user))
      .send({ token });

  async function listInvites(by = owner) {
    const res = await http()
      .get(`/households/${by.householdId}/invites`)
      .set('Authorization', auth(by))
      .expect(200);
    return res.body as InviteListItemDto[];
  }

  async function memberEmails(hid = owner.householdId): Promise<string[]> {
    const res = await http()
      .get(`/households/${hid}`)
      .set('Authorization', auth(owner))
      .expect(200);
    return (res.body as HouseholdDetailResponseDto).members.map((m) => m.email);
  }

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    resetThrottling(app);
    owner = await registerUser(app, 'owner');
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets the invitee join with the token in the body', async () => {
    const jane = await registerUser(app, 'jane');
    const { token } = await invite(jane.email);

    await accept(jane, token).expect(204);

    expect(await memberEmails()).toContain(jane.email);
  });

  it('matches the invitee email case-insensitively', async () => {
    const jane = await registerUser(app, 'jane');
    const { token } = await invite(jane.email.toUpperCase());

    await accept(jane, token).expect(204);
  });

  it('refuses a user whose email is not the invitee email (403)', async () => {
    const jane = await registerUser(app, 'jane');
    const mallory = await registerUser(app, 'mallory');
    const { token } = await invite(jane.email);

    await accept(mallory, token).expect(403);

    expect(await memberEmails()).not.toContain(mallory.email);
    // The invite was not spent: the real invitee can still join.
    await accept(jane, token).expect(204);
  });

  it('no longer accepts the token in the URL path', async () => {
    const jane = await registerUser(app, 'jane');
    const { token } = await invite(jane.email);

    await http()
      .post(`/households/invites/${token}/accept`)
      .set('Authorization', auth(jane))
      .expect(404);
  });

  it('rejects a malformed token body (400)', async () => {
    const jane = await registerUser(app, 'jane');
    await accept(jane, 'not-a-token').expect(400);
  });

  it('answers 410 for an unknown token', async () => {
    const jane = await registerUser(app, 'jane');
    await accept(jane, 'a'.repeat(64)).expect(410);
  });

  it('answers 409 when the invitee accepts again', async () => {
    const jane = await registerUser(app, 'jane');
    const { token } = await invite(jane.email);
    await accept(jane, token).expect(204);

    await accept(jane, token).expect(409);
  });

  it('answers 409 for an existing member and does not spend the invite', async () => {
    const jane = await registerUser(app, 'jane');
    const first = await invite(jane.email);
    const second = await invite(jane.email);
    await accept(jane, first.token).expect(204);

    await accept(jane, second.token).expect(409);

    const pending = (await listInvites()).filter((i) => i.status === 'pending');
    expect(pending).toHaveLength(1);
  });

  it('accepts two invites of one user in parallel without a 500', async () => {
    const jane = await registerUser(app, 'jane');
    const a = await invite(jane.email);
    const b = await invite(jane.email);

    const statuses = (
      await Promise.all([accept(jane, a.token), accept(jane, b.token)])
    )
      .map((r) => r.status)
      .sort();

    expect(statuses).toEqual([204, 409]);
    expect((await memberEmails()).filter((e) => e === jane.email)).toHaveLength(
      1,
    );
  });

  it('answers 409, not 500, when the membership is inserted concurrently', async () => {
    const jane = await registerUser(app, 'jane');
    const janeId = app.get(JwtService).decode<JwtPayload>(jane.accessToken).sub;
    const { token } = await invite(jane.email);

    // A concurrent accept that has inserted the membership but not committed
    // yet. The request does not see it, its own insert waits for it and then
    // inserts nothing: 409 without spending the invite.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const ready = new Promise<void>((resolve) => (inserted = resolve));
    const concurrent = app
      .get(MikroORM)
      .em.fork()
      .transactional(async (txEm) => {
        await txEm
          .getConnection()
          .execute(
            'insert into "household_members" ("household_id", "user_id", "role") values (?, ?, ?)',
            [owner.householdId, janeId, 'member'],
            'run',
            txEm.getTransactionContext(),
          );
        inserted();
        await held;
      });
    await ready;
    const pending = accept(jane, token).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await concurrent;

    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: 'already_member' });
    expect((await listInvites())[0].status).toBe('pending');
  });

  it('answers 410 for an expired invite', async () => {
    const jane = await registerUser(app, 'jane');
    const { token } = await invite(jane.email);
    const em = app.get(MikroORM).em.fork();
    const [created] = await listInvites();
    await em.nativeUpdate(
      HouseholdInvite,
      { id: created.id },
      { expires_at: new Date(Date.now() - 1000) },
    );

    await accept(jane, token).expect(410);
    expect((await listInvites())[0].status).toBe('expired');
  });

  describe('owner endpoints', () => {
    it('lists the invites of the household without tokens', async () => {
      await invite('a@example.com');
      await invite('b@example.com');

      const list = await listInvites();

      expect(list.map((i) => i.invitee_email)).toEqual([
        'b@example.com',
        'a@example.com',
      ]);
      expect(Object.keys(list[0]).sort()).toEqual([
        'created_at',
        'expires_at',
        'id',
        'invitee_email',
        'status',
      ]);
      expect(list[0].status).toBe('pending');
    });

    it('revokes an invite: accepting it then answers 410', async () => {
      const jane = await registerUser(app, 'jane');
      const { token } = await invite(jane.email);
      const [created] = await listInvites();

      await http()
        .delete(`/households/${owner.householdId}/invites/${created.id}`)
        .set('Authorization', auth(owner))
        .expect(204);

      expect((await listInvites())[0].status).toBe('revoked');
      await accept(jane, token).expect(410);
      expect(await memberEmails()).not.toContain(jane.email);
    });

    it('revoking twice is idempotent', async () => {
      await invite('a@example.com');
      const [created] = await listInvites();
      const path = `/households/${owner.householdId}/invites/${created.id}`;

      await http().delete(path).set('Authorization', auth(owner)).expect(204);
      await http().delete(path).set('Authorization', auth(owner)).expect(204);
    });

    it('refuses to revoke an accepted invite (409)', async () => {
      const jane = await registerUser(app, 'jane');
      const { token } = await invite(jane.email);
      await accept(jane, token).expect(204);
      const [created] = await listInvites();

      await http()
        .delete(`/households/${owner.householdId}/invites/${created.id}`)
        .set('Authorization', auth(owner))
        .expect(409);
    });

    it("answers 404 when revoking another household's invite", async () => {
      const other = await registerUser(app, 'other');
      await invite('a@example.com', other);
      const [foreign] = await listInvites(other);

      await http()
        .delete(`/households/${owner.householdId}/invites/${foreign.id}`)
        .set('Authorization', auth(owner))
        .expect(404);
      expect((await listInvites(other))[0].status).toBe('pending');
    });

    it('refuses list and revoke to a non-owner member (403)', async () => {
      const jane = await registerUser(app, 'jane');
      const { token } = await invite(jane.email);
      await accept(jane, token).expect(204);
      const [created] = await listInvites();
      const base = `/households/${owner.householdId}/invites`;

      await http().get(base).set('Authorization', auth(jane)).expect(403);
      await http()
        .delete(`${base}/${created.id}`)
        .set('Authorization', auth(jane))
        .expect(403);
    });
  });

  describe('active invite limit', () => {
    it('refuses a new invite once 20 are pending, until one is revoked', async () => {
      for (let i = 0; i < 20; i++) await invite(`limit-${i}@example.com`);

      await http()
        .post(`/households/${owner.householdId}/invites`)
        .set('Authorization', auth(owner))
        .send({ email: 'one-too-many@example.com' })
        .expect(409);

      const [newest] = await listInvites();
      await http()
        .delete(`/households/${owner.householdId}/invites/${newest.id}`)
        .set('Authorization', auth(owner))
        .expect(204);
      await invite('one-too-many@example.com');
    });

    it('does not count expired invites', async () => {
      for (let i = 0; i < 20; i++) await invite(`limit-${i}@example.com`);
      const em = app.get(MikroORM).em.fork();
      await em.nativeUpdate(
        HouseholdInvite,
        { household: { id: owner.householdId } },
        { expires_at: new Date(Date.now() - 1000) },
      );

      await invite('fresh@example.com');
    });
  });
});
