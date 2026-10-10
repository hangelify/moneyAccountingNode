import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { applyTrustProxy, parseTrustProxy } from '../src/config/trust-proxy';
import { BillPhotoService } from '../src/modules/bill/bill-photo.service';
import { TokenResponseDto } from '../src/modules/auth/dto/token-response.dto';
import { HouseholdResponseDto } from '../src/modules/household/dto/household-response.dto';

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
      raw_extracted_text: '',
      items: [],
    },
    requestId: '00000000-0000-4000-8000-000000000000',
  });

  beforeAll(async () => {
    process.env.JWT_SECRET =
      process.env.JWT_SECRET ||
      'test-jwt-secret-key-minimum-32-characters-long';
    process.env.JWT_REFRESH_SECRET =
      process.env.JWT_REFRESH_SECRET ||
      'test-refresh-secret-key-minimum-32-characters-long';
    process.env.JWT_EXPIRES_IN_MS = process.env.JWT_EXPIRES_IN_MS || '900000';
    process.env.JWT_REFRESH_EXPIRES_IN_MS =
      process.env.JWT_REFRESH_EXPIRES_IN_MS || '604800000';
    delete process.env.AI_USER_LIMIT_PER_MINUTE;
    delete process.env.AI_USER_LIMIT_PER_DAY;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BillPhotoService)
      .useValue({ parseAndCategorize })
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    // Trust X-Forwarded-For, so every request below comes from another IP.
    applyTrustProxy(app, parseTrustProxy('1'));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function registerUser(): Promise<{ token: string; hid: string }> {
    const email = `ai-limit-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Forwarded-For', `198.51.100.${Math.floor(Math.random() * 250)}`)
      .send({
        email,
        password: 'password123',
        first_name: 'Ai',
        last_name: 'Limit',
        username: 'ailimit',
      })
      .expect(201);
    const token = (reg.body as TokenResponseDto).access_token;
    const list = await request(app.getHttpServer())
      .get('/households')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return { token, hid: (list.body as HouseholdResponseDto[])[0].id };
  }

  it('refuses the 11th call of a user within a minute, even from different IPs', async () => {
    const { token, hid } = await registerUser();

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
