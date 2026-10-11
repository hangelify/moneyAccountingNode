import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, resetThrottling } from './utils/app';
import { TokenResponseDto } from '../src/modules/auth/dto/token-response.dto';
import { HouseholdResponseDto } from '../src/modules/household/dto/household-response.dto';

describe('Auth Registration (e2e)', () => {
  let app: NestExpressApplication;

  const register = (body: object) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Client-Type', 'mobile')
      .send(body);

  beforeAll(async () => {
    app = await createTestApp();
  });

  // Registration is limited to 10 per minute; each test starts at 0.
  beforeEach(() => {
    resetThrottling(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('should register a new user successfully', async () => {
    const response = await register({
      email: 'register-ok@example.com',
      password: 'password123',
      first_name: 'Test',
      last_name: 'User',
      username: 'testuser',
    });

    expect(response.status).toBe(201);

    const body = response.body as TokenResponseDto;
    expect(body).toHaveProperty('token_type', 'Bearer');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.access_token.length).toBeGreaterThan(0);
    expect(body.refresh_token.length).toBeGreaterThan(0);
    expect(typeof body.expires_in).toBe('number');
    expect(body.expires_in).toBeGreaterThan(0);

    // The new user gets a personal household and can use the token at once.
    const households = await request(app.getHttpServer())
      .get('/households')
      .set('Authorization', `Bearer ${body.access_token}`)
      .expect(200);
    expect(households.body as HouseholdResponseDto[]).toHaveLength(1);
  });

  it('rejects a second registration with the same email', async () => {
    const body = {
      email: 'register-dup@example.com',
      password: 'password123',
      first_name: 'Dup',
    };
    await register(body).expect(201);
    await register(body).expect(400);
  });

  it('logs in with the registered email in a different case', async () => {
    await register({
      email: ' Case-Login@Example.COM ',
      password: 'password123',
      first_name: 'Case',
    }).expect(201);

    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: 'case-login@example.com', password: 'password123' })
      .expect(200);
  });

  it('rejects a second registration with the same email in another case', async () => {
    const body = { password: 'password123', first_name: 'Dup' };
    await register({ ...body, email: 'Case-Dup@Example.com' }).expect(201);
    await register({ ...body, email: 'case-dup@example.COM' }).expect(400);
  });

  it.each([
    [
      'an invalid email',
      { email: 'not-an-email', password: 'password123', first_name: 'Bad' },
    ],
    [
      'a short password',
      { email: 'short@example.com', password: '123', first_name: 'Bad' },
    ],
    [
      'a missing first_name',
      { email: 'nofn@example.com', password: 'password123' },
    ],
    [
      'an empty first_name',
      { email: 'emptyfn@example.com', password: 'password123', first_name: '' },
    ],
    [
      'a 7-character password',
      { email: 'seven@example.com', password: 'abcdefg', first_name: 'Bad' },
    ],
    [
      'a password longer than 72 bytes',
      {
        email: 'long-pw@example.com',
        password: 'a'.repeat(73),
        first_name: 'B',
      },
    ],
    [
      // 37 characters, 74 bytes: bcrypt would silently drop the tail.
      'a multibyte password longer than 72 bytes',
      { email: 'mb-pw@example.com', password: 'é'.repeat(37), first_name: 'B' },
    ],
    [
      'a first_name longer than 255 characters',
      {
        email: 'long-fn@example.com',
        password: 'password123',
        first_name: 'x'.repeat(256),
      },
    ],
    [
      'a last_name longer than 255 characters',
      {
        email: 'long-ln@example.com',
        password: 'password123',
        first_name: 'Ok',
        last_name: 'x'.repeat(256),
      },
    ],
    [
      'a username longer than 255 characters',
      {
        email: 'long-un@example.com',
        password: 'password123',
        first_name: 'Ok',
        username: 'x'.repeat(256),
      },
    ],
  ])('rejects %s with 400', async (_label, body) => {
    await register(body).expect(400);
  });

  it('accepts a password of exactly 72 bytes and names of 255 characters', async () => {
    await register({
      email: 'limits-ok@example.com',
      password: 'é'.repeat(36),
      first_name: 'x'.repeat(255),
      last_name: 'y'.repeat(255),
      username: 'z'.repeat(255),
    }).expect(201);

    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: 'limits-ok@example.com', password: 'é'.repeat(36) })
      .expect(200);
  });
});
