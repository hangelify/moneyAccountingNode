import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, registerUser, TestUser } from './utils/app';
import { CategoryBaseResponseDto } from '../src/modules/category/dto/category-base-response.dto';

describe('Category seed-defaults (e2e)', () => {
  let app: NestExpressApplication;
  let userA: TestUser;
  let userB: TestUser;

  async function listCategories(
    user: TestUser,
    householdId: string,
  ): Promise<CategoryBaseResponseDto[]> {
    const res = await request(app.getHttpServer())
      .get(`/households/${householdId}/categories`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    return res.body as CategoryBaseResponseDto[];
  }

  async function deleteAllCategories(user: TestUser): Promise<void> {
    for (const c of await listCategories(user, user.householdId)) {
      await request(app.getHttpServer())
        .delete(`/households/${user.householdId}/categories/${c.id}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(204);
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    userA = await registerUser(app, 'seed-a');
    userB = await registerUser(app, 'seed-b');
  });

  afterAll(async () => {
    await app.close();
  });

  it("user A cannot seed user B's household (403) and B's categories stay untouched", async () => {
    await deleteAllCategories(userB);

    await request(app.getHttpServer())
      .post(`/households/${userB.householdId}/categories/seed-defaults`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(403);

    expect(await listCategories(userB, userB.householdId)).toHaveLength(0);
  });

  it('a member can seed their own household (204) and categories are created', async () => {
    await deleteAllCategories(userA);

    await request(app.getHttpServer())
      .post(`/households/${userA.householdId}/categories/seed-defaults`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(204);

    expect(
      (await listCategories(userA, userA.householdId)).length,
    ).toBeGreaterThan(0);
  });

  it('rejects an invalid hid with 400, not 500', async () => {
    await request(app.getHttpServer())
      .post('/households/not-a-uuid/categories/seed-defaults')
      .set('Authorization', `Bearer ${userA.accessToken}`)
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
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(404);
  });
});
