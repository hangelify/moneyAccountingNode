import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import {
  createTestApp,
  registerUser,
  resetThrottling,
  TestUser,
} from './utils/app';
import type { HouseholdResponseDto } from '../src/modules/household';
import type { CategoryBaseResponseDto } from '../src/modules/category';
import { CategoryDefaultsService } from '../src/modules/category/category-defaults.service';
import { DEFAULT_CATEGORY_TREE } from '../src/modules/category/defaults';

// HAN-22: creating and deleting households.
describe('Household lifecycle (e2e)', () => {
  let app: NestExpressApplication;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const auth = (user: TestUser): string => `Bearer ${user.accessToken}`;
  const sql = <T>(query: string, params: unknown[] = []): Promise<T> =>
    app.get(MikroORM).em.getConnection().execute(query, params) as Promise<T>;

  async function createHousehold(
    user: TestUser,
    body: object,
    status = 201,
  ): Promise<HouseholdResponseDto> {
    const res = await http()
      .post('/households')
      .set('Authorization', auth(user))
      .send(body)
      .expect(status);
    return res.body as HouseholdResponseDto;
  }

  async function listHouseholds(
    user: TestUser,
  ): Promise<HouseholdResponseDto[]> {
    const res = await http()
      .get('/households')
      .set('Authorization', auth(user))
      .expect(200);
    return res.body as HouseholdResponseDto[];
  }

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(() => {
    resetThrottling(app);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('creation', () => {
    it('creates a household with the default categories', async () => {
      const user = await registerUser(app, 'create-seed');
      const created = await createHousehold(user, { name: 'Trip' });

      const res = await http()
        .get(`/households/${created.id}/categories`)
        .set('Authorization', auth(user))
        .expect(200);
      const names = (res.body as CategoryBaseResponseDto[])
        .map((c) => c.name)
        .sort();
      expect(names).toEqual(DEFAULT_CATEGORY_TREE.map((n) => n.name).sort());
    });

    it("uses the given currency, else the user's", async () => {
      const user = await registerUser(app, 'create-currency');
      expect(
        (await createHousehold(user, { name: 'Lei', currency: 'MDL' }))
          .currency,
      ).toBe('MDL');
      expect((await createHousehold(user, { name: 'Plain' })).currency).toBe(
        'EUR',
      );
    });

    it('rolls registration back when seeding fails', async () => {
      jest
        .spyOn(app.get(CategoryDefaultsService), 'seedForHousehold')
        .mockRejectedValueOnce(new Error('seed down'));
      const email = `seed-down-${String(Date.now())}@example.com`;

      await http()
        .post('/auth/register')
        .set('X-Client-Type', 'mobile')
        .send({ email, password: 'password123', first_name: 'Down' })
        .expect(500);

      const rows = await sql<{ n: number }[]>(
        'select count(*)::int as n from users where email = ?',
        [email],
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('rolls household creation back when seeding fails', async () => {
      const user = await registerUser(app, 'create-seed-down');
      jest
        .spyOn(app.get(CategoryDefaultsService), 'seedForHousehold')
        .mockRejectedValueOnce(new Error('seed down'));

      await createHousehold(user, { name: 'Broken' }, 500);

      expect(await listHouseholds(user)).toHaveLength(1);
    });
  });
});
