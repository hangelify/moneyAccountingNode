import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, TestAppOptions } from './utils/app';

describe('HTTP hardening: Swagger exposure and security headers (e2e)', () => {
  let app: NestExpressApplication;

  // /health opens the database connection: an app that never reached the
  // database hangs in close() under Jest.
  async function startApp(options?: TestAppOptions): Promise<void> {
    app = await createTestApp(options);
    await request(app.getHttpServer()).get('/health').expect(200);
  }

  afterEach(async () => {
    await app.close();
  });

  it('does not serve Swagger in production', async () => {
    await startApp({ env: { NODE_ENV: 'production' } });

    await request(app.getHttpServer()).get('/api').expect(404);
    await request(app.getHttpServer()).get('/api-json').expect(404);
  });

  it('serves Swagger outside production', async () => {
    await startApp();

    const res = await request(app.getHttpServer()).get('/api').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('sends helmet security headers', async () => {
    await startApp();

    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
