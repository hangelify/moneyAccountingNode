import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, registerUser, TestUser } from './utils/app';
import { CategoryBaseResponseDto } from '../src/modules/category/dto/category-base-response.dto';
import { DEFAULT_CATEGORY_TREE } from '../src/modules/category/defaults';

// Names are unique case-insensitively among live rows: categories per
// household, sub-categories per category, budgets per household, planning
// horizons per budget. Duplicates are 409, including under concurrency.
describe('Name uniqueness (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;

  const http = () => request(app.getHttpServer());
  const auth = () => `Bearer ${user.accessToken}`;
  const base = () => `/households/${user.householdId}`;

  async function createBudget(name: string): Promise<string> {
    const res = await http()
      .post(`${base()}/budgets`)
      .set('Authorization', auth())
      .send({ name })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function postHorizon(budgetId: string, name: string) {
    return http()
      .post(`${base()}/planing-horizons`)
      .set('Authorization', auth())
      .send({
        budget_id: budgetId,
        name,
        amount: 100,
        currency: 'EUR',
        period_type: 'MONTHLY',
      });
  }

  async function createHorizon(budgetId: string, name: string) {
    const res = await postHorizon(budgetId, name).expect(201);
    return (res.body as { id: string }).id;
  }

  function postCategory(horizonId: string, name: string) {
    return http()
      .post(`${base()}/categories`)
      .set('Authorization', auth())
      .send({ planing_horizon_id: horizonId, name });
  }

  function postSubCategory(categoryId: string, name: string) {
    return http()
      .post(`${base()}/sub-categories`)
      .set('Authorization', auth())
      .send({ category_id: categoryId, name });
  }

  async function listCategories(): Promise<CategoryBaseResponseDto[]> {
    const res = await http()
      .get(`${base()}/categories`)
      .set('Authorization', auth())
      .expect(200);
    return res.body as CategoryBaseResponseDto[];
  }

  let horizonId: string;

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'uniq');
    const budgetId = await createBudget('Uniqueness budget');
    horizonId = await createHorizon(budgetId, 'Uniqueness horizon');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('seed defaults', () => {
    it('two concurrent seeds create a single default set', async () => {
      for (const c of await listCategories()) {
        await http()
          .delete(`${base()}/categories/${c.id}`)
          .set('Authorization', auth())
          .expect(204);
      }

      const results = await Promise.all(
        [1, 2].map(() =>
          http()
            .post(`${base()}/categories/seed-defaults`)
            .set('Authorization', auth()),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([204, 204]);

      const names = (await listCategories()).map((c) => c.name);
      expect(names).toHaveLength(DEFAULT_CATEGORY_TREE.length);
      expect(new Set(names).size).toBe(names.length);
    });

    it('does not duplicate a default the household has in another case', async () => {
      for (const c of await listCategories()) {
        await http()
          .delete(`${base()}/categories/${c.id}`)
          .set('Authorization', auth())
          .expect(204);
      }
      const lower = DEFAULT_CATEGORY_TREE[0].name.toLowerCase();
      await postCategory(horizonId, lower).expect(201);

      await http()
        .post(`${base()}/categories/seed-defaults`)
        .set('Authorization', auth())
        .expect(204);

      const names = (await listCategories()).map((c) => c.name.toLowerCase());
      expect(names.filter((n) => n === lower)).toHaveLength(1);
      expect(names).toHaveLength(DEFAULT_CATEGORY_TREE.length);
    });
  });

  describe('categories', () => {
    it('rejects a case-insensitive duplicate with 409', async () => {
      await postCategory(horizonId, 'Pets').expect(201);
      await postCategory(horizonId, 'PETS').expect(409);
    });

    it('rejects renaming onto an existing name with 409', async () => {
      await postCategory(horizonId, 'Garden').expect(201);
      const res = await postCategory(horizonId, 'Garage').expect(201);
      await http()
        .put(`${base()}/categories/${(res.body as { id: string }).id}`)
        .set('Authorization', auth())
        .send({ name: 'garden' })
        .expect(409);
    });

    it('allows reusing the name of a deleted category', async () => {
      const res = await postCategory(horizonId, 'Hobby').expect(201);
      await http()
        .delete(`${base()}/categories/${(res.body as { id: string }).id}`)
        .set('Authorization', auth())
        .expect(204);
      await postCategory(horizonId, 'hobby').expect(201);
    });

    it('concurrent creates of one name: one 201, the rest 409', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => postCategory(horizonId, 'Race category')),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
    });

    it('bulk rejects duplicates within the request with 400', async () => {
      await http()
        .post(`${base()}/categories/bulk`)
        .set('Authorization', auth())
        .send({
          planing_horizon_id: horizonId,
          categories: [{ name: 'Travel' }, { name: 'TRAVEL' }],
        })
        .expect(400);
      const names = (await listCategories()).map((c) => c.name.toLowerCase());
      expect(names).not.toContain('travel');
    });

    it('bulk rejects a name that already exists with 409', async () => {
      await postCategory(horizonId, 'Gifts').expect(201);
      await http()
        .post(`${base()}/categories/bulk`)
        .set('Authorization', auth())
        .send({
          planing_horizon_id: horizonId,
          categories: [{ name: 'Charity' }, { name: 'gifts' }],
        })
        .expect(409);
    });
  });

  describe('sub-categories', () => {
    let categoryId: string;

    beforeAll(async () => {
      const res = await postCategory(horizonId, 'Sub parent').expect(201);
      categoryId = (res.body as { id: string }).id;
    });

    it('rejects a case-insensitive duplicate within a category with 409', async () => {
      await postSubCategory(categoryId, 'apples').expect(201);
      await postSubCategory(categoryId, 'Apples').expect(409);
    });

    it('allows the same name in another category', async () => {
      const other = await postCategory(horizonId, 'Sub other').expect(201);
      await postSubCategory((other.body as { id: string }).id, 'apples').expect(
        201,
      );
    });

    it('bulk rejects duplicates within the request with 400', async () => {
      await http()
        .post(`${base()}/sub-categories/bulk`)
        .set('Authorization', auth())
        .send({
          category_id: categoryId,
          sub_categories: [{ name: 'pears' }, { name: 'PEARS' }],
        })
        .expect(400);
    });
  });

  describe('budgets', () => {
    it('rejects a case-insensitive duplicate with 409', async () => {
      await createBudget('Holidays');
      await http()
        .post(`${base()}/budgets`)
        .set('Authorization', auth())
        .send({ name: 'holidays' })
        .expect(409);
    });

    it('concurrent creates of one name: one 201, the rest 409, never 500', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          http()
            .post(`${base()}/budgets`)
            .set('Authorization', auth())
            .send({ name: 'Race budget' }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
    });
  });

  describe('planning horizons', () => {
    it('rejects a case-insensitive duplicate within a budget with 409', async () => {
      const budgetId = await createBudget('PH budget 1');
      await createHorizon(budgetId, 'Q1');
      await postHorizon(budgetId, 'q1').expect(409);
    });

    it('allows the same name in another budget', async () => {
      const b1 = await createBudget('PH budget 2');
      const b2 = await createBudget('PH budget 3');
      await createHorizon(b1, 'Q2');
      await createHorizon(b2, 'Q2');
    });

    it('allows reusing the name of an archived horizon', async () => {
      const budgetId = await createBudget('PH budget 4');
      const id = await createHorizon(budgetId, 'Q3');
      await http()
        .delete(`${base()}/planing-horizons/${id}`)
        .set('Authorization', auth())
        .expect(204);
      await createHorizon(budgetId, 'Q3');
    });

    it('concurrent creates of one name: one 201, the rest 409', async () => {
      const budgetId = await createBudget('PH budget 5');
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => postHorizon(budgetId, 'Race horizon')),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
    });
  });
});
