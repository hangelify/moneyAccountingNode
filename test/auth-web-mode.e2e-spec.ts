import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  registerUser,
  resetThrottling,
  TestUser,
} from './utils/app';
import type { TokenResponseDto } from '../src/modules/auth/dto/token-response.dto';

const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173';

const refreshCookie = (res: request.Response): string | undefined =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith('refresh_token='));

// "refresh_token=<value>; Path=/auth; ..." -> "refresh_token=<value>"
const cookiePair = (setCookie: string) => setCookie.split(';')[0];

// Web clients keep the refresh token in an HttpOnly cookie guarded by an
// Origin check; native clients opt into body tokens with X-Client-Type.
describe('Auth web and mobile client modes (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;

  const http = () => request(app.getHttpServer());
  const credentials = () => ({ email: user.email, password: user.password });

  async function webLogin(): Promise<{
    body: TokenResponseDto;
    cookie: string;
  }> {
    const res = await http()
      .post('/auth/login')
      .set('Origin', FRONTEND)
      .send(credentials())
      .expect(200);
    const cookie = refreshCookie(res);
    expect(cookie).toBeDefined();
    return { body: res.body as TokenResponseDto, cookie: cookiePair(cookie!) };
  }

  const webRefresh = (cookie?: string) => {
    const req = http().post('/auth/refresh').set('Origin', FRONTEND);
    return cookie ? req.set('Cookie', cookie) : req;
  };

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'webmode');
  });

  beforeEach(() => {
    resetThrottling(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('login sets an HttpOnly Secure SameSite=Strict cookie on /auth and omits refresh_token from the body', async () => {
    const res = await http()
      .post('/auth/login')
      .set('Origin', FRONTEND)
      .send(credentials())
      .expect(200);

    const cookie = refreshCookie(res);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Strict/);
    expect(cookie).toMatch(/; Path=\/auth/);
    expect(cookie).toMatch(/; Max-Age=\d+/);
    expect(res.body).not.toHaveProperty('refresh_token');
    expect((res.body as TokenResponseDto).access_token).toEqual(
      expect.any(String),
    );
  });

  it('register in web mode also delivers the refresh token as a cookie', async () => {
    const res = await http()
      .post('/auth/register')
      .set('Origin', FRONTEND)
      .send({
        email: `webmode-reg-${Date.now()}@example.com`,
        password: 'password123',
        first_name: 'web',
      })
      .expect(201);

    expect(refreshCookie(res)).toMatch(/; HttpOnly/);
    expect(res.body).not.toHaveProperty('refresh_token');
  });

  it('refresh with the cookie returns a new access token and rotates the cookie', async () => {
    const { cookie } = await webLogin();

    const res = await webRefresh(cookie).expect(200);
    const rotated = refreshCookie(res);
    expect(rotated).toBeDefined();
    expect(cookiePair(rotated!)).not.toBe(cookie);
    expect(res.body).not.toHaveProperty('refresh_token');
    expect((res.body as TokenResponseDto).access_token).toEqual(
      expect.any(String),
    );

    // The rotated-out token is now a reuse attempt.
    await webRefresh(cookie).expect(401);
  });

  it('refresh ignores a body refresh_token in web mode', async () => {
    const mobile = await http()
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .send(credentials())
      .expect(200);
    const bodyToken = (mobile.body as TokenResponseDto).refresh_token;

    await webRefresh().send({ refresh_token: bodyToken }).expect(401);
  });

  it('rejects login and refresh from a foreign Origin with 403', async () => {
    const { cookie } = await webLogin();

    const login = await http()
      .post('/auth/login')
      .set('Origin', 'https://evil.example')
      .send(credentials())
      .expect(403);
    expect(refreshCookie(login)).toBeUndefined();

    await http()
      .post('/auth/refresh')
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie)
      .expect(403);
  });

  it('rejects mobile mode when an Origin is present', async () => {
    await http()
      .post('/auth/login')
      .set('Origin', FRONTEND)
      .set('X-Client-Type', 'mobile')
      .send(credentials())
      .expect(403);
  });

  it('rejects requests without Origin or client type', async () => {
    await http().post('/auth/login').send(credentials()).expect(403);
  });

  it('rejects an unknown client type', async () => {
    await http()
      .post('/auth/login')
      .set('X-Client-Type', 'desktop')
      .send(credentials())
      .expect(400);
  });

  it('logout clears the cookie and revokes the session', async () => {
    const { body, cookie } = await webLogin();

    const res = await http()
      .post('/auth/logout')
      .set('Origin', FRONTEND)
      .set('Authorization', `Bearer ${body.access_token}`)
      .set('Cookie', cookie)
      .expect(200);

    const cleared = refreshCookie(res);
    expect(cleared).toMatch(/^refresh_token=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/; Path=\/auth/);

    await webRefresh(cookie).expect(401);
  });

  it('mobile mode returns refresh_token in the body and sets no cookie', async () => {
    const res = await http()
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .send(credentials())
      .expect(200);

    expect(refreshCookie(res)).toBeUndefined();
    const tokens = res.body as TokenResponseDto;
    expect(tokens.refresh_token).toEqual(expect.any(String));

    const refreshed = await http()
      .post('/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refresh_token: tokens.refresh_token })
      .expect(200);
    expect(refreshCookie(refreshed)).toBeUndefined();
    expect((refreshed.body as TokenResponseDto).refresh_token).toEqual(
      expect.any(String),
    );
  });

  it('mobile refresh without a body token is a 400', async () => {
    await http()
      .post('/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({})
      .expect(400);
  });

  it('accepts same-origin requests such as Swagger UI', async () => {
    const res = await http()
      .post('/auth/login')
      .set('Host', 'api.example.test')
      .set('Origin', 'https://api.example.test')
      .send(credentials())
      .expect(200);
    expect(refreshCookie(res)).toBeDefined();
  });
});
