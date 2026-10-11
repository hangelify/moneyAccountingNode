import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import sharp from 'sharp';
import { createTestApp, registerUser } from './utils/app';
import { STORAGE_SERVICE } from '../src/modules/storage/storage.service';

// No AI provider key at all, as on a dev machine with only manual accounting.
describe('parse-photo without any AI provider (e2e)', () => {
  let app: NestExpressApplication;
  let token: string;
  let hid: string;
  const put = jest.fn();
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    required: process.env.AI_REQUIRED,
  };

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AI_REQUIRED = 'false';
    app = await createTestApp({
      override: (builder) =>
        builder.overrideProvider(STORAGE_SERVICE).useValue({
          put,
          exists: jest.fn(),
          getSignedUrl: jest.fn(),
        }),
    });
    ({ accessToken: token, householdId: hid } = await registerUser(
      app,
      'no-ai',
    ));
  });

  afterAll(async () => {
    await app?.close();
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.required === undefined) delete process.env.AI_REQUIRED;
    else process.env.AI_REQUIRED = saved.required;
  });

  it('boots and serves manual accounting', async () => {
    await request(app.getHttpServer())
      .get(`/households/${hid}/bills`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('answers parse-photo with 503 and the request id, without storing the photo', async () => {
    const jpeg = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#fff' },
    })
      .jpeg()
      .toBuffer();

    const res = await request(app.getHttpServer())
      .post(`/households/${hid}/bills/parse-photo`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', jpeg, {
        filename: 'bill.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Photo recognition is not available',
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('documents every parse-photo status and the error schema in Swagger', async () => {
    const res = await request(app.getHttpServer()).get('/api-json').expect(200);
    const doc = res.body as {
      paths: Record<string, { post: { responses: Record<string, unknown> } }>;
      components: { schemas: Record<string, { properties: object }> };
    };

    const responses =
      doc.paths['/households/{hid}/bills/parse-photo'].post.responses;
    expect(Object.keys(responses).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '413',
      '415',
      '422',
      '429',
      '502',
      '503',
    ]);
    expect(responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ParsePhotoResponseDto' },
        },
      },
    });
    expect(
      Object.keys(doc.components.schemas.AiErrorResponseDto.properties),
    ).toEqual(['statusCode', 'error', 'message', 'request_id']);
    for (const status of [
      '400',
      '401',
      '403',
      '413',
      '415',
      '422',
      '429',
      '502',
      '503',
    ]) {
      expect(responses[status]).toMatchObject({
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/AiErrorResponseDto' },
          },
        },
      });
    }
  });
});
