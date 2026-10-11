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
import { RefreshToken } from '../src/entities/refresh-token.entity';
import type { TokenResponseDto } from '../src/modules/auth/dto/token-response.dto';

// Token format and response conventions: RFC 6749 §5.1 (no caching of token
// responses), RFC 6750 §3 (WWW-Authenticate on 401), RFC 8725 / RFC 9068
// (pinned algorithm, iss, aud, explicit typ, no personal data in claims).
describe('Auth token standards (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;

  const http = () => request(app.getHttpServer());
  const me = (accessToken: string) =>
    http().get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
  const jwt = () => app.get(JwtService);

  async function login(): Promise<TokenResponseDto> {
    const res = await http()
      .post('/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    return res.body as TokenResponseDto;
  }

  // Claims overridden with undefined are dropped; exp is set anew on signing.
  const withClaims = (
    payload: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ) => {
    const claims: Record<string, unknown> = { ...payload, ...overrides };
    delete claims.exp;
    for (const key of Object.keys(claims)) {
      if (claims[key] === undefined) delete claims[key];
    }
    return claims;
  };

  const decodeComplete = (token: string) =>
    jwt().decode<{
      header: Record<string, unknown>;
      payload: Record<string, unknown>;
    }>(token, { complete: true });

  // Re-signs the claims of a real access token with the access secret,
  // overriding claims and signing options.
  async function resign(
    overrides: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<string> {
    const tokens = await login();
    const { header, payload } = decodeComplete(tokens.access_token);
    return jwt().sign(withClaims(payload, overrides), {
      secret: process.env.JWT_SECRET,
      expiresIn: 300,
      header: { alg: 'HS256', typ: header.typ as string },
      ...options,
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'std');
  });

  beforeEach(() => {
    resetThrottling(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('token responses are not cached', () => {
    const expectNoStore = (res: request.Response) => {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['pragma']).toBe('no-cache');
    };

    it('on register', async () => {
      const res = await http()
        .post('/auth/register')
        .send({
          email: `std-reg-${Date.now()}@example.com`,
          password: 'password123',
          first_name: 'std',
        })
        .expect(201);
      expectNoStore(res);
    });

    it('on login', async () => {
      const res = await http()
        .post('/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(200);
      expectNoStore(res);
    });

    it('on refresh', async () => {
      const tokens = await login();
      const res = await http()
        .post('/auth/refresh')
        .send({ refresh_token: tokens.refresh_token })
        .expect(200);
      expectNoStore(res);
    });
  });

  describe('401 carries a Bearer challenge', () => {
    it('without a token: realm only, no error code', async () => {
      const res = await http().get('/auth/me').expect(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="api"');
    });

    it('with an invalid token: error="invalid_token"', async () => {
      const res = await me('not-a-jwt').expect(401);
      expect(res.headers['www-authenticate']).toBe(
        'Bearer realm="api", error="invalid_token"',
      );
    });

    it('with a token of a revoked session: error="invalid_token"', async () => {
      const tokens = await login();
      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${tokens.access_token}`)
        .send({ refresh_token: tokens.refresh_token })
        .expect(200);
      const res = await me(tokens.access_token).expect(401);
      expect(res.headers['www-authenticate']).toBe(
        'Bearer realm="api", error="invalid_token"',
      );
    });
  });

  describe('issued tokens', () => {
    it('carry only sub, sid, jti, type and the registered claims', async () => {
      const tokens = await login();
      for (const token of [tokens.access_token, tokens.refresh_token]) {
        const { payload } = decodeComplete(token);
        expect(Object.keys(payload).sort()).toEqual(
          ['aud', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub', 'type'].sort(),
        );
        expect(JSON.stringify(payload)).not.toContain(user.email);
      }
    });

    it('name issuer and audience', async () => {
      const tokens = await login();
      const { payload } = decodeComplete(tokens.access_token);
      expect(payload.iss).toBe(process.env.JWT_ISSUER);
      expect(payload.aud).toBe(process.env.JWT_AUDIENCE);
    });

    it('are explicitly typed: at+jwt for access, a different typ for refresh', async () => {
      const tokens = await login();
      const access = decodeComplete(tokens.access_token).header;
      const refresh = decodeComplete(tokens.refresh_token).header;
      expect(access).toMatchObject({ alg: 'HS256', typ: 'at+jwt' });
      expect(refresh.alg).toBe('HS256');
      expect(refresh.typ).toEqual(expect.any(String));
      expect(refresh.typ).not.toBe('at+jwt');
    });
  });

  describe('access token verification', () => {
    it('accepts a re-signed token with unchanged claims', async () => {
      await me(await resign({})).expect(200);
    });

    it('rejects a token for another audience', async () => {
      await me(await resign({ aud: 'another-api' })).expect(401);
    });

    it('rejects a token from another issuer', async () => {
      await me(await resign({ iss: 'https://evil.example' })).expect(401);
    });

    it('rejects a token without iss and aud', async () => {
      await me(await resign({ iss: undefined, aud: undefined })).expect(401);
    });

    it('rejects a token signed with HS512', async () => {
      const token = await resign(
        {},
        { algorithm: 'HS512', header: { alg: 'HS512', typ: 'at+jwt' } },
      );
      await me(token).expect(401);
    });

    it('rejects an unsigned token (alg: none)', async () => {
      const tokens = await login();
      const { payload } = decodeComplete(tokens.access_token);
      const b64 = (v: object) =>
        Buffer.from(JSON.stringify(v)).toString('base64url');
      const unsigned = `${b64({ alg: 'none', typ: 'at+jwt' })}.${b64(payload)}.`;
      await me(unsigned).expect(401);
    });

    it('rejects a token without the at+jwt typ', async () => {
      const token = await resign({}, { header: { alg: 'HS256', typ: 'JWT' } });
      await me(token).expect(401);
    });
  });

  describe('refresh token verification', () => {
    const refresh = (refreshToken: string) =>
      http().post('/auth/refresh').send({ refresh_token: refreshToken });

    async function resignRefresh(
      overrides: Record<string, unknown>,
      options: Record<string, unknown> = {},
    ): Promise<string> {
      const tokens = await login();
      const { header, payload } = decodeComplete(tokens.refresh_token);
      const token = jwt().sign(withClaims(payload, overrides), {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: 300,
        header: { alg: 'HS256', typ: header.typ as string },
        ...options,
      });
      // Points the stored row at the re-signed token, so only the token
      // checks can refuse it.
      await app
        .get(MikroORM)
        .em.fork()
        .nativeUpdate(
          RefreshToken,
          { jti: payload.jti as string },
          {
            token_hash: createHash('sha256').update(token).digest('hex'),
          },
        );
      return token;
    }

    it('accepts a re-signed refresh token with unchanged claims', async () => {
      await refresh(await resignRefresh({})).expect(200);
    });

    it('rejects a refresh token for another audience', async () => {
      await refresh(await resignRefresh({ aud: 'another-api' })).expect(401);
    });

    it('rejects a refresh token from another issuer', async () => {
      await refresh(
        await resignRefresh({ iss: 'https://evil.example' }),
      ).expect(401);
    });

    it('rejects a refresh token signed with HS512', async () => {
      const tokens = await login();
      const typ = decodeComplete(tokens.refresh_token).header.typ as string;
      await refresh(
        await resignRefresh(
          {},
          { algorithm: 'HS512', header: { alg: 'HS512', typ } },
        ),
      ).expect(401);
    });

    it('rejects a refresh token with the access typ', async () => {
      await refresh(
        await resignRefresh({}, { header: { alg: 'HS256', typ: 'at+jwt' } }),
      ).expect(401);
    });
  });
});
