import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, registerUser } from './utils/app';
import { BillPhotoService } from '../src/modules/bill/bill-photo.service';

// 1×1 transparent PNG: passes the endpoint's magic-number file type check.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('parse-photo per-user AI limit (e2e)', () => {
  let app: NestExpressApplication;
  // Stands in for the AI call: the limit is under test, not the parsing.
  const parseAndCategorize = jest.fn().mockResolvedValue({
    parsed: {
      draft_id: '',
      market_name: null,
      bill_date: null,
      currency: null,
      total_amount: null,
      items: [],
    },
    requestId: '00000000-0000-4000-8000-000000000000',
  });

  beforeAll(async () => {
    app = await createTestApp({
      // Trust X-Forwarded-For, so every request below comes from another IP.
      trustProxy: '1',
      override: (builder) =>
        builder
          .overrideProvider(BillPhotoService)
          .useValue({ parseAndCategorize }),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses the 11th call of a user within a minute, even from different IPs', async () => {
    const { accessToken: token, householdId: hid } = await registerUser(
      app,
      'ai-limit',
    );

    const statuses: number[] = [];
    let last: request.Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await request(app.getHttpServer())
        .post(`/households/${hid}/bills/parse-photo`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', `203.0.113.${i + 1}`)
        .attach('image', PNG, {
          filename: 'bill.png',
          contentType: 'image/png',
        });
      statuses.push(last.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    expect(last!.headers['retry-after']).toBeDefined();
    expect((last!.body as { message: string }).message).toMatch(
      /AI request limit/i,
    );
    expect(parseAndCategorize).toHaveBeenCalledTimes(10);
  });
});
