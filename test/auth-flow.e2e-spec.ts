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
    http().post('/auth/refresh').send({ refresh_token: refreshToken });

  async function login(): Promise<TokenResponseDto> {
    const res = await http()
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    return res.body as TokenResponseDto;
  }

  const sessionId = (accessToken: string) =>
    app.get(JwtService).decode<JwtPayload>(accessToken).sid;

  const em = () => app.get(MikroORM).em.fork();

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
        .set('Authorization', `Bearer ${ending.access_token}`)
        .expect(200);

      await me(staying.access_token).expect(200);
      await refresh(staying.refresh_token).expect(200);
    });

    it('requires authentication', async () => {
      await http().post('/auth/logout').expect(401);
    });
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

    it('rejects an expired access token', async () => {
      const tokens = await login();
      const payload = app
        .get(JwtService)
        .decode<JwtPayload>(tokens.access_token);
      const expired = app.get(JwtService).sign(
        {
          sub: payload.sub,
          email: payload.email,
          type: 'access',
          sid: payload.sid,
        },
        { secret: process.env.JWT_SECRET, expiresIn: -60 },
      );
      await me(expired).expect(401);
    });

    it('rejects a token signed with another secret', async () => {
      const tokens = await login();
      const payload = app
        .get(JwtService)
        .decode<JwtPayload>(tokens.access_token);
      const forged = app
        .get(JwtService)
        .sign(
          { sub: payload.sub, type: 'access', sid: payload.sid },
          { secret: 'another-secret-at-least-32-characters-long' },
        );
      await me(forged).expect(401);
    });

    it('rejects a request without a token', async () => {
      await http().get('/auth/me').expect(401);
    });
  });
});
