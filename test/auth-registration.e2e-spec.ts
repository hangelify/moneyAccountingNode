import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { TokenResponseDto } from '../src/modules/auth/dto/token-response.dto';
import { HouseholdResponseDto } from '../src/modules/household/dto/household-response.dto';

describe('Auth Registration (e2e)', () => {
  let app: NestExpressApplication;

  const register = (body: object) =>
    request(app.getHttpServer()).post('/auth/register').send(body);

  beforeAll(async () => {
    app = await createTestApp();
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
  ])('rejects %s with 400', async (_label, body) => {
    await register(body).expect(400);
  });
});
