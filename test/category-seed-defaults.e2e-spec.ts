import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { TokenResponseDto } from '../src/modules/auth/dto/token-response.dto';
import { HouseholdResponseDto } from '../src/modules/household/dto/household-response.dto';
import { CategoryBaseResponseDto } from '../src/modules/category/dto/category-base-response.dto';

interface TestUser {
  token: string;
  householdId: string;
}

describe('Category seed-defaults (e2e)', () => {
  let app: INestApplication<App>;
  let userA: TestUser;
  let userB: TestUser;

  async function registerUser(): Promise<TestUser> {
    const email = `seed-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password: 'password123',
        first_name: 'Seed',
        last_name: 'Tester',
        username: 'seedtester',
      })
      .expect(201);
    const token = (reg.body as TokenResponseDto).access_token;

    const list = await request(app.getHttpServer())
      .get('/households')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const households = list.body as HouseholdResponseDto[];
    return { token, householdId: households[0].id };
  }

  async function listCategories(
    user: TestUser,
    householdId: string,
  ): Promise<CategoryBaseResponseDto[]> {
    const res = await request(app.getHttpServer())
      .get(`/households/${householdId}/categories`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    return res.body as CategoryBaseResponseDto[];
  }

  async function deleteAllCategories(user: TestUser): Promise<void> {
    for (const c of await listCategories(user, user.householdId)) {
      await request(app.getHttpServer())
        .delete(`/households/${user.householdId}/categories/${c.id}`)
        .set('Authorization', `Bearer ${user.token}`)
        .expect(204);
    }
  }

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

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    userA = await registerUser();
    userB = await registerUser();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("user A cannot seed user B's household (403) and B's categories stay untouched", async () => {
    await deleteAllCategories(userB);

    await request(app.getHttpServer())
      .post(`/households/${userB.householdId}/categories/seed-defaults`)
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(403);

    expect(await listCategories(userB, userB.householdId)).toHaveLength(0);
  });

  it('a member can seed their own household (204) and categories are created', async () => {
    await deleteAllCategories(userA);

    await request(app.getHttpServer())
      .post(`/households/${userA.householdId}/categories/seed-defaults`)
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(204);

    expect(
      (await listCategories(userA, userA.householdId)).length,
    ).toBeGreaterThan(0);
  });

  it('rejects an invalid hid with 400, not 500', async () => {
    await request(app.getHttpServer())
      .post('/households/not-a-uuid/categories/seed-defaults')
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(400);
  });

  it('requires authentication (401)', async () => {
    await request(app.getHttpServer())
      .post(`/households/${userA.householdId}/categories/seed-defaults`)
      .expect(401);
  });

  it('the old unscoped route no longer exists (404)', async () => {
    await request(app.getHttpServer())
      .post(
        `/users/me/seed-default-categories?household_id=${userB.householdId}`,
      )
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(404);
  });
});
