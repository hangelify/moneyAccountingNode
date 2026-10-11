import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './utils/app';

describe('AppController (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  // The settings below come from configureApp(), shared with main.ts.
  it('allows CORS from FRONTEND_URL only', async () => {
    const res = await request(app.getHttpServer())
      .options('/auth/login')
      .set('Origin', process.env.FRONTEND_URL!)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBe(
      process.env.FRONTEND_URL,
    );

    const other = await request(app.getHttpServer())
      .options('/auth/login')
      .set('Origin', 'http://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(other.headers['access-control-allow-origin']).not.toBe(
      'http://evil.example',
    );
  });

  it('rejects unknown body fields with 400 (global ValidationPipe)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: 'a@example.com', password: 'password123', admin: true });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('admin');
  });

  it('serves the Swagger document', async () => {
    await request(app.getHttpServer()).get('/api-json').expect(200);
  });
});
