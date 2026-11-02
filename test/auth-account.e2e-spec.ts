import type { NestExpressApplication } from '@nestjs/platform-express';
import { MikroORM } from '@mikro-orm/core';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import {
  createTestApp,
  registerUser,
  resetThrottling,
  TestUser,
} from './utils/app';
import { User } from '../src/entities/user.entity';
import type { TokenResponseDto } from '../src/modules/auth/dto/token-response.dto';

// Account lifecycle: password change, password hashing and soft-deleted
// users, through the HTTP API.
describe('Auth account lifecycle (e2e)', () => {
  let app: NestExpressApplication;

  const http = () => request(app.getHttpServer());
  const me = (accessToken: string) =>
    http().get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
  const refresh = (refreshToken: string) =>
    http()
      .post('/auth/refresh')
      .set('X-Client-Type', 'mobile')
      .send({ refresh_token: refreshToken });
  const login = (email: string, password: string, userAgent = 'e2e') =>
    http()
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .set('User-Agent', userAgent)
      .send({ email, password });
  const changePassword = (accessToken: string, body: object) =>
    http()
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);

  const em = () => app.get(MikroORM).em.fork();
  const storedHash = async (email: string) =>
    (await em().findOneOrFail(User, { email })).password;

  async function loginAs(user: TestUser): Promise<TokenResponseDto> {
    const res = await login(user.email, user.password).expect(200);
    return res.body as TokenResponseDto;
  }

  beforeAll(async () => {
    app = await createTestApp();
  });

  // Login and refresh are limited to 10 per minute; each test starts at 0.
  beforeEach(() => {
    resetThrottling(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/change-password', () => {
    it('stores a new hash and ends every other session', async () => {
      const user = await registerUser(app, 'chpw');
      const current = await loginAs(user);
      const other = await loginAs(user);
      const oldHash = await storedHash(user.email);

      await changePassword(current.access_token, {
        current_password: user.password,
        new_password: 'brand-new-password',
      }).expect(204);

      const newHash = await storedHash(user.email);
      expect(newHash).not.toBe(oldHash);
      expect(bcrypt.getRounds(newHash)).toBe(12);
      expect(await bcrypt.compare('brand-new-password', newHash)).toBe(true);

      // Other sessions, including the one opened at registration, are gone.
      await me(other.access_token).expect(401);
      await refresh(other.refresh_token).expect(401);
      await me(user.accessToken).expect(401);
      await refresh(user.refreshToken).expect(401);

      // The session that changed the password stays.
      await me(current.access_token).expect(200);
      await refresh(current.refresh_token).expect(200);

      await login(user.email, user.password).expect(401);
      await login(user.email, 'brand-new-password').expect(200);
    });

    it('rejects a wrong current password and keeps everything as is', async () => {
      const user = await registerUser(app, 'chpw-wrong');
      const current = await loginAs(user);
      const oldHash = await storedHash(user.email);

      await changePassword(current.access_token, {
        current_password: 'not-the-password',
        new_password: 'brand-new-password',
      }).expect(400);

      expect(await storedHash(user.email)).toBe(oldHash);
      await me(user.accessToken).expect(200);
    });

    it.each([
      ['a new password longer than 72 bytes', { new_password: 'é'.repeat(37) }],
      ['a new password shorter than 8 characters', { new_password: 'short' }],
      ['a missing current password', { current_password: undefined }],
    ])('rejects %s with 400', async (_label, override) => {
      const user = await registerUser(app, 'chpw-dto');
      await changePassword(user.accessToken, {
        current_password: user.password,
        new_password: 'brand-new-password',
        ...override,
      }).expect(400);
    });

    it('requires authentication', async () => {
      await http()
        .post('/auth/change-password')
        .send({ current_password: 'x', new_password: 'brand-new-password' })
        .expect(401);
    });
  });

  it('rehashes a legacy cost-10 hash on login', async () => {
    const user = await registerUser(app, 'rehash');
    await em().nativeUpdate(
      User,
      { email: user.email },
      { password: await bcrypt.hash(user.password, 10) },
    );

    await login(user.email, user.password).expect(200);

    const hash = await storedHash(user.email);
    expect(bcrypt.getRounds(hash)).toBe(12);
    expect(await bcrypt.compare(user.password, hash)).toBe(true);
  });

  describe('soft-deleted user', () => {
    it('cannot log in, use an access token or refresh', async () => {
      const user = await registerUser(app, 'deleted');
      await em().nativeUpdate(
        User,
        { email: user.email },
        { deleted_at: new Date() },
      );

      await login(user.email, user.password).expect(401);
      await me(user.accessToken).expect(401);
      await refresh(user.refreshToken).expect(401);
    });
  });

  it('stores at most 512 characters of the User-Agent', async () => {
    const user = await registerUser(app, 'ua');
    const res = await login(user.email, user.password, 'u'.repeat(2000)).expect(
      200,
    );
    const tokens = res.body as TokenResponseDto;

    const sessions = await http()
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .expect(200);
    const mine = (
      sessions.body as Array<{ current: boolean; user_agent: string }>
    ).find((s) => s.current)!;
    expect(mine.user_agent).toBe('u'.repeat(512));
  });
});
