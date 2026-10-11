import { createHash } from 'crypto';
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
import { Session } from '../src/entities/session.entity';
import { RefreshToken } from '../src/entities/refresh-token.entity';
import { Log, LogSource } from '../src/entities/log.entity';
import type { TokenResponseDto } from '../src/modules/auth/dto/token-response.dto';
import type { JwtPayload } from '../src/modules/auth/types/jwt-payload.interface';

// Session lifecycle: refresh rotation, reuse detection, logout, expiry and
// token-type confusion, through the HTTP API.
describe('Auth session flow (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;

  const http = () => request(app.getHttpServer());
  const me = (accessToken: string) =>
    http().get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
  const refresh = (refreshToken: string) =>
    http()
      .post('/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refresh_token: refreshToken });

  async function login(): Promise<TokenResponseDto> {
    const res = await http()
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: user.email, password: user.password })
      .expect(200);
    return res.body as TokenResponseDto;
  }

  const sessionId = (accessToken: string) =>
    app.get(JwtService).decode<JwtPayload>(accessToken).sid;

  const em = () => app.get(MikroORM).em.fork();

  // A unique User-Agent tags the log rows written for one request.
  let agentSeq = 0;
  const uniqueAgent = () => `e2e-agent-${++agentSeq}-${Date.now()}`;
  const authLogs = (userAgent: string) =>
    em().find(
      Log,
      { source: LogSource.AUTH, user_agent: userAgent },
      { orderBy: { created_at: 'desc' } },
    );

  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'flow');
  });

  // Login and refresh are limited to 10 per minute; each test starts at 0.
  beforeEach(() => {
    resetThrottling(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a fresh access token', async () => {
    const tokens = await login();
    const res = await me(tokens.access_token).expect(200);
    expect((res.body as { email: string }).email).toBe(user.email);
  });

  describe('refresh', () => {
    it('rotates the pair: the new tokens work and the session stays the same', async () => {
      const first = await login();
      const res = await refresh(first.refresh_token).expect(200);
      const second = res.body as TokenResponseDto;

      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(second.access_token).not.toBe(first.access_token);
      expect(sessionId(second.access_token)).toBe(
        sessionId(first.access_token),
      );
      await me(second.access_token).expect(200);
      await refresh(second.refresh_token).expect(200);
    });

    it('treats reuse of a rotated refresh token as theft and revokes the session', async () => {
      const first = await login();
      const second = (await refresh(first.refresh_token).expect(200))
        .body as TokenResponseDto;

      await refresh(first.refresh_token).expect(401);

      // Everything issued for that session is dead now.
      await refresh(second.refresh_token).expect(401);
      await me(second.access_token).expect(401);
      const session = await em().findOneOrFail(Session, {
        id: sessionId(first.access_token),
      });
      expect(session.is_active).toBe(false);
    });

    it('does not touch the other sessions of the user on reuse', async () => {
      const victim = await login();
      const other = await login();
      await refresh(victim.refresh_token).expect(200);
      await refresh(victim.refresh_token).expect(401);

      await me(other.access_token).expect(200);
      await refresh(other.refresh_token).expect(200);
    });

    it('rejects an access token in place of a refresh token', async () => {
      const tokens = await login();
      await refresh(tokens.access_token).expect(401);
    });

    it('rejects a garbage refresh token', async () => {
      await refresh('not-a-jwt').expect(401);
    });

    it('keeps the old refresh token valid when issuing the new pair fails', async () => {
      const tokens = await login();
      const sign = jest
        .spyOn(app.get(JwtService), 'signAsync')
        .mockRejectedValueOnce(new Error('signing failed'));
      try {
        await refresh(tokens.refresh_token).expect(500);
      } finally {
        sign.mockRestore();
      }

      // The revocation was rolled back with the failed rotation, so the
      // client's retry is a normal refresh, not a reuse.
      await refresh(tokens.refresh_token).expect(200);
    });

    it('lets exactly one of two concurrent refreshes with the same token win', async () => {
      // The loser gets 401 either way: blocked on the row lock and then
      // matching no row, or reading the token after the commit and taking
      // the reuse path (which also revokes the session, so the winner's
      // tokens are not asserted here).
      const tokens = await login();
      const results = await Promise.all([
        refresh(tokens.refresh_token),
        refresh(tokens.refresh_token),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    describe('with a reuse grace window', () => {
      beforeEach(() => {
        process.env.REFRESH_REUSE_GRACE_SECONDS = '30';
      });

      afterEach(() => {
        delete process.env.REFRESH_REUSE_GRACE_SECONDS;
      });

      it('rejects a retry of a just-rotated token without revoking the session', async () => {
        const first = await login();
        const second = (await refresh(first.refresh_token).expect(200))
          .body as TokenResponseDto;

        await refresh(first.refresh_token).expect(401);

        await me(second.access_token).expect(200);
        await refresh(second.refresh_token).expect(200);
      });

      it('still revokes the session on reuse after the window', async () => {
        const first = await login();
        const second = (await refresh(first.refresh_token).expect(200))
          .body as TokenResponseDto;
        await em().nativeUpdate(
          RefreshToken,
          { token_hash: sha256(first.refresh_token) },
          { revoked_at: new Date(Date.now() - 31_000) },
        );

        await refresh(first.refresh_token).expect(401);

        await refresh(second.refresh_token).expect(401);
        await me(second.access_token).expect(401);
      });
    });

    it('rejects a refresh token whose row has expired', async () => {
      const tokens = await login();
      await em().nativeUpdate(
        RefreshToken,
        { session: { id: sessionId(tokens.access_token) } },
        { expires_at: new Date(Date.now() - 1000) },
      );
      await refresh(tokens.refresh_token).expect(401);
    });
  });

  describe('logout', () => {
    it('ends the current session: its access and refresh tokens stop working', async () => {
      const tokens = await login();
      await http()
        .post('/auth/logout')
        .set('X-Client-Type', 'mobile')
        .set('Authorization', `Bearer ${tokens.access_token}`)
        .expect(200);

      await me(tokens.access_token).expect(401);
      await refresh(tokens.refresh_token).expect(401);
    });

    it('leaves the other sessions of the user alive', async () => {
      const ending = await login();
      const staying = await login();
      await http()
        .post('/auth/logout')
        .set('X-Client-Type', 'mobile')
        .set('Authorization', `Bearer ${ending.access_token}`)
        .expect(200);

      await me(staying.access_token).expect(200);
      await refresh(staying.refresh_token).expect(200);
    });

    it('requires authentication', async () => {
      await http()
        .post('/auth/logout')
        .set('X-Client-Type', 'mobile')
        .expect(401);
    });

    it('ends the current session even when the body names another session', async () => {
      const current = await login();
      const other = await login();
      await http()
        .post('/auth/logout')
        .set('X-Client-Type', 'mobile')
        .set('Authorization', `Bearer ${current.access_token}`)
        .send({ refresh_token: other.refresh_token })
        .expect(200);

      await me(current.access_token).expect(401);
      await me(other.access_token).expect(200);
      await refresh(other.refresh_token).expect(200);
    });

    it('clears the refresh cookie in web mode', async () => {
      const tokens = await login();
      const res = await http()
        .post('/auth/logout')
        .set('Origin', process.env.FRONTEND_URL!)
        .set('Authorization', `Bearer ${tokens.access_token}`)
        .expect(200);

      expect(String(res.headers['set-cookie'])).toMatch(/^refresh_token=;/);
      await me(tokens.access_token).expect(401);
    });
  });

  describe('logout events', () => {
    it('logs the logout with the session id', async () => {
      const tokens = await login();
      const agent = uniqueAgent();
      await http()
        .post('/auth/logout')
        .set('X-Client-Type', 'mobile')
        .set('User-Agent', agent)
        .set('Authorization', `Bearer ${tokens.access_token}`)
        .expect(200);

      const [log] = await authLogs(agent);
      expect(log.message).toContain('User logged out');
      expect(log.metadata).toMatchObject({
        session_id: sessionId(tokens.access_token),
      });
    });
  });

  describe('revoke (RFC 7009)', () => {
    const revoke = (body: object) =>
      http().post('/auth/revoke').set('X-Client-Type', 'mobile').send(body);

    it('revokes the session of the token without a bearer token', async () => {
      const tokens = await login();
      await revoke({ refresh_token: tokens.refresh_token }).expect(200);

      await me(tokens.access_token).expect(401);
      await refresh(tokens.refresh_token).expect(401);
    });

    it('accepts an expired refresh token', async () => {
      const tokens = await login();
      await em().nativeUpdate(
        RefreshToken,
        { session: { id: sessionId(tokens.access_token) } },
        { expires_at: new Date(Date.now() - 1000) },
      );
      await revoke({ refresh_token: tokens.refresh_token }).expect(200);

      const session = await em().findOneOrFail(Session, {
        id: sessionId(tokens.access_token),
      });
      expect(session.is_active).toBe(false);
    });

    it('logs the revocation with the session id', async () => {
      const tokens = await login();
      const agent = uniqueAgent();
      await revoke({ refresh_token: tokens.refresh_token })
        .set('User-Agent', agent)
        .expect(200);

      const [log] = await authLogs(agent);
      expect(log.message).toContain('Session revoked by refresh token');
      expect(log.metadata).toMatchObject({
        session_id: sessionId(tokens.access_token),
        success: true,
      });
    });

    it('answers 200 to an unknown token and logs it', async () => {
      const other = await login();
      const agent = uniqueAgent();
      await revoke({ refresh_token: 'garbage' })
        .set('User-Agent', agent)
        .expect(200);

      await me(other.access_token).expect(200);
      const [log] = await authLogs(agent);
      expect(log.message).toContain('Token revocation - token not recognized');
    });

    it('answers 200 to an access token and revokes nothing', async () => {
      const tokens = await login();
      await revoke({ refresh_token: tokens.access_token }).expect(200);
      await me(tokens.access_token).expect(200);
    });

    it('answers 200 to a token that is already revoked', async () => {
      const tokens = await login();
      await revoke({ refresh_token: tokens.refresh_token }).expect(200);
      await revoke({ refresh_token: tokens.refresh_token }).expect(200);
    });

    it('ends the session for a rotated token too', async () => {
      const first = await login();
      const second = (await refresh(first.refresh_token).expect(200))
        .body as TokenResponseDto;
      await revoke({ refresh_token: first.refresh_token }).expect(200);

      await me(second.access_token).expect(401);
      await refresh(second.refresh_token).expect(401);
    });

    it('accepts and ignores token_type_hint', async () => {
      const tokens = await login();
      await revoke({
        refresh_token: tokens.refresh_token,
        token_type_hint: 'refresh_token',
      }).expect(200);
      await me(tokens.access_token).expect(401);
    });

    it('rejects a mobile request without a token as invalid_request', async () => {
      const res = await revoke({}).expect(400);
      expect(res.body).toMatchObject({ error: 'invalid_request' });
    });

    it('answers 200 and clears the cookie in web mode without a cookie', async () => {
      const res = await http()
        .post('/auth/revoke')
        .set('Origin', process.env.FRONTEND_URL!)
        .expect(200);
      expect(String(res.headers['set-cookie'])).toMatch(/^refresh_token=;/);
    });

    it('refuses a cookie sent from a foreign origin', async () => {
      const tokens = await login();
      await http()
        .post('/auth/revoke')
        .set('Origin', 'http://evil.example')
        .set('Cookie', `refresh_token=${tokens.refresh_token}`)
        .expect(403);
      await me(tokens.access_token).expect(200);
    });

    it('reads the refresh cookie in web mode and clears it', async () => {
      const tokens = await login();
      const res = await http()
        .post('/auth/revoke')
        .set('Origin', process.env.FRONTEND_URL!)
        .set('Cookie', `refresh_token=${tokens.refresh_token}`)
        .expect(200);

      expect(String(res.headers['set-cookie'])).toMatch(/^refresh_token=;/);
      await me(tokens.access_token).expect(401);
    });
  });

  // Each test works on its own user: logout-all ends every session of it.
  describe('session management', () => {
    let owner: TestUser;

    const loginAs = async (u: TestUser): Promise<TokenResponseDto> =>
      (
        await http()
          .post('/auth/login')
          .set('X-Client-Type', 'mobile')
          .set('User-Agent', 'e2e-device')
          .send({ email: u.email, password: u.password })
          .expect(200)
      ).body as TokenResponseDto;

    beforeEach(async () => {
      owner = await registerUser(app, 'sessions');
    });

    describe('POST /auth/logout-all', () => {
      it('ends every session of the user at once', async () => {
        const a = await loginAs(owner);
        const b = await loginAs(owner);
        await http()
          .post('/auth/logout-all')
          .set('X-Client-Type', 'mobile')
          .set('Authorization', `Bearer ${a.access_token}`)
          .expect(200);

        for (const t of [a, b]) {
          await me(t.access_token).expect(401);
          await refresh(t.refresh_token).expect(401);
        }
        await me(owner.accessToken).expect(401);
      });

      it('logs how many sessions it ended', async () => {
        await loginAs(owner);
        const agent = uniqueAgent();
        await http()
          .post('/auth/logout-all')
          .set('X-Client-Type', 'mobile')
          .set('User-Agent', agent)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .expect(200);

        const [log] = await authLogs(agent);
        expect(log.message).toContain('User logged out of all sessions');
        expect(log.metadata).toMatchObject({
          email: owner.email,
          revoked_sessions: 2,
        });
      });

      it('leaves the sessions of other users alive', async () => {
        const mine = await loginAs(owner);
        const theirs = await login();
        await http()
          .post('/auth/logout-all')
          .set('X-Client-Type', 'mobile')
          .set('Authorization', `Bearer ${mine.access_token}`)
          .expect(200);

        await me(theirs.access_token).expect(200);
      });

      it('requires authentication', async () => {
        await http()
          .post('/auth/logout-all')
          .set('X-Client-Type', 'mobile')
          .expect(401);
      });
    });

    describe('GET /auth/sessions', () => {
      it('lists the active sessions of the user and flags the current one', async () => {
        const current = await loginAs(owner);
        const ended = await loginAs(owner);
        await revokeViaLogout(ended.access_token);

        const res = await http()
          .get('/auth/sessions')
          .set('Authorization', `Bearer ${current.access_token}`)
          .expect(200);
        const sessions = res.body as Array<Record<string, unknown>>;

        const ids = sessions.map((s) => s.id);
        expect(ids).toContain(sessionId(current.access_token));
        expect(ids).toContain(sessionId(owner.accessToken));
        expect(ids).not.toContain(sessionId(ended.access_token));

        const mine = sessions.find(
          (s) => s.id === sessionId(current.access_token),
        )!;
        expect(mine).toMatchObject({ current: true, user_agent: 'e2e-device' });
        expect(Object.keys(mine).sort()).toEqual(
          [
            'created_at',
            'current',
            'id',
            'ip',
            'last_activity_at',
            'user_agent',
          ].sort(),
        );
        expect(sessions.filter((s) => s.current)).toHaveLength(1);
      });

      it('does not show sessions of other users', async () => {
        const theirs = await login();
        const res = await http()
          .get('/auth/sessions')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .expect(200);
        const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
        expect(ids).not.toContain(sessionId(theirs.access_token));
      });

      it('leaves out sessions past their absolute lifetime', async () => {
        const stale = await loginAs(owner);
        await em().nativeUpdate(
          Session,
          { id: sessionId(stale.access_token) },
          { absolute_expires_at: new Date(Date.now() - 1000) },
        );
        const res = await http()
          .get('/auth/sessions')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .expect(200);
        const ids = (res.body as Array<{ id: string }>).map((s) => s.id);
        expect(ids).not.toContain(sessionId(stale.access_token));
      });

      it('orders by the latest activity first', async () => {
        const older = await loginAs(owner);
        const newer = await loginAs(owner);
        await em().nativeUpdate(
          Session,
          { id: sessionId(older.access_token) },
          { last_activity_at: new Date(Date.now() - 3_600_000) },
        );
        await em().nativeUpdate(
          Session,
          { id: sessionId(owner.accessToken) },
          { last_activity_at: new Date(Date.now() - 7_200_000) },
        );
        const res = await http()
          .get('/auth/sessions')
          .set('Authorization', `Bearer ${newer.access_token}`)
          .expect(200);
        expect((res.body as Array<{ id: string }>).map((s) => s.id)).toEqual([
          sessionId(newer.access_token),
          sessionId(older.access_token),
          sessionId(owner.accessToken),
        ]);
      });

      it('requires authentication', async () => {
        await http().get('/auth/sessions').expect(401);
      });
    });

    describe('DELETE /auth/sessions/:id', () => {
      const deleteSession = (accessToken: string, id: string) =>
        http()
          .delete(`/auth/sessions/${id}`)
          .set('Authorization', `Bearer ${accessToken}`);

      it('ends another session of the user', async () => {
        const other = await loginAs(owner);
        await deleteSession(
          owner.accessToken,
          sessionId(other.access_token)!,
        ).expect(204);

        await me(other.access_token).expect(401);
        await refresh(other.refresh_token).expect(401);
        await me(owner.accessToken).expect(200);
      });

      it('logs the ended session', async () => {
        const other = await loginAs(owner);
        const agent = uniqueAgent();
        await deleteSession(owner.accessToken, sessionId(other.access_token)!)
          .set('User-Agent', agent)
          .expect(204);

        const [log] = await authLogs(agent);
        expect(log.message).toContain('Session revoked by user');
        expect(log.metadata).toMatchObject({
          session_id: sessionId(other.access_token),
        });
      });

      it('answers 404 for a session of another user and leaves it alive', async () => {
        const theirs = await login();
        await deleteSession(
          owner.accessToken,
          sessionId(theirs.access_token)!,
        ).expect(404);

        await me(theirs.access_token).expect(200);
      });

      it('answers 404 for a session that is already ended', async () => {
        const other = await loginAs(owner);
        await revokeViaLogout(other.access_token);
        await deleteSession(
          owner.accessToken,
          sessionId(other.access_token)!,
        ).expect(404);
      });

      it('rejects an id that is not a UUID', async () => {
        await deleteSession(owner.accessToken, 'not-a-uuid').expect(400);
      });

      it('requires authentication', async () => {
        await http()
          .delete(`/auth/sessions/${sessionId(owner.accessToken)}`)
          .expect(401);
      });
    });

    async function revokeViaLogout(accessToken: string): Promise<void> {
      await http()
        .post('/auth/logout')
        .set('X-Client-Type', 'mobile')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    }
  });

  describe('expired session', () => {
    it('refuses access and refresh once the absolute session lifetime is over', async () => {
      const tokens = await login();
      await em().nativeUpdate(
        Session,
        { id: sessionId(tokens.access_token) },
        { absolute_expires_at: new Date(Date.now() - 1000) },
      );

      await me(tokens.access_token).expect(401);
      await refresh(tokens.refresh_token).expect(401);
    });
  });

  describe('access token checks', () => {
    it('rejects a refresh token used as a bearer token', async () => {
      const tokens = await login();
      await me(tokens.refresh_token).expect(401);
    });

    // Re-signs a real access token with all its claims and header kept, so
    // only the changed option can make the token fail.
    async function resignAccess(options: object): Promise<string> {
      const tokens = await login();
      const { header, payload } = app.get(JwtService).decode<{
        header: { typ: string };
        payload: Record<string, unknown>;
      }>(tokens.access_token, { complete: true });
      const claims = { ...payload };
      delete claims.exp;
      return app.get(JwtService).sign(claims, {
        secret: process.env.JWT_SECRET,
        expiresIn: 300,
        header: { alg: 'HS256', typ: header.typ },
        ...options,
      });
    }

    it('accepts a re-signed access token with unchanged claims', async () => {
      await me(await resignAccess({})).expect(200);
    });

    it('rejects an expired access token', async () => {
      await me(await resignAccess({ expiresIn: -60 })).expect(401);
    });

    it('rejects a token signed with another secret', async () => {
      await me(
        await resignAccess({
          secret: 'another-secret-at-least-32-characters-long',
        }),
      ).expect(401);
    });

    it('rejects a request without a token', async () => {
      await http().get('/auth/me').expect(401);
    });
  });
});
