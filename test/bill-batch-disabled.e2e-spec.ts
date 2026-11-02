import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, registerUser, TestUser } from './utils/app';

// The e2e environment runs with BILL_BATCH_ENABLED=false.
describe('Batch photo routes with batch parsing disabled (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'batch-off');
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: 'get' | 'post', path: string) =>
    request(app.getHttpServer())
      [method](`/households/${user.householdId}/${path}`)
      .set('Authorization', `Bearer ${user.accessToken}`);

  it.each([
    ['post', 'bills/parse-photos'],
    ['get', `bill-batches/${randomUUID()}`],
    ['post', `bills/${randomUUID()}/retry`],
    // Reaches the batch controller, not BillController's GET bills/:id
    // (whose ParseUUIDPipe would answer 400).
    ['get', 'bills/events'],
  ] as const)('%s %s answers 503', async (method, path) => {
    const res = await call(method, path).expect(503);
    expect(res.body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Batch photo parsing is disabled',
      request_id: null,
    });
  });

  it('still authenticates before answering 503', async () => {
    await request(app.getHttpServer())
      .get(`/households/${user.householdId}/bills/events`)
      .expect(401);
  });

  it('leaves the bill routes next to them working', async () => {
    await call('get', `bills/${randomUUID()}`).expect(404);
    await call('get', 'bills/drafts').expect(200);
  });

  it('documents the batch routes in Swagger', async () => {
    const res = await request(app.getHttpServer()).get('/api-json').expect(200);
    const paths = Object.keys((res.body as { paths: object }).paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/households/{hid}/bills/parse-photos',
        '/households/{hid}/bill-batches/{id}',
        '/households/{hid}/bills/{id}/retry',
        '/households/{hid}/bills/events',
      ]),
    );
  });
});
