import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, registerUser, TestUser } from './utils/app';
import { CategoryBaseResponseDto } from '../src/modules/category';
import { DEFAULT_CATEGORY_TREE } from '../src/modules/category';
import { defined } from '../src/common/testing/defined';

// Names are unique case-insensitively among live rows: categories per
// household, sub-categories per category. Duplicates are 409, including
// under concurrency.
describe('Name uniqueness (e2e)', () => {
  let app: NestExpressApplication;
  let user: TestUser;

  const http = () => request(app.getHttpServer());
  const auth = () => `Bearer ${user.accessToken}`;
  const base = () => `/households/${user.householdId}`;

  function postCategory(name: string) {
    return http()
      .post(`${base()}/categories`)
      .set('Authorization', auth())
      .send({ name });
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

  beforeAll(async () => {
    app = await createTestApp();
    user = await registerUser(app, 'uniq');
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
      const lower = defined(DEFAULT_CATEGORY_TREE[0]).name.toLowerCase();
      await postCategory(lower).expect(201);

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
      await postCategory('Pets').expect(201);
      await postCategory('PETS').expect(409);
    });

    it('rejects renaming onto an existing name with 409', async () => {
      await postCategory('Garden').expect(201);
      const res = await postCategory('Garage').expect(201);
      await http()
        .put(`${base()}/categories/${(res.body as { id: string }).id}`)
        .set('Authorization', auth())
        .send({ name: 'garden' })
        .expect(409);
    });

    it('allows reusing the name of a deleted category', async () => {
      const res = await postCategory('Hobby').expect(201);
      await http()
        .delete(`${base()}/categories/${(res.body as { id: string }).id}`)
        .set('Authorization', auth())
        .expect(204);
      await postCategory('hobby').expect(201);
    });

    it('concurrent creates of one name: one 201, the rest 409', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => postCategory('Race category')),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
    });

    it('bulk rejects duplicates within the request with 400', async () => {
      await http()
        .post(`${base()}/categories/bulk`)
        .set('Authorization', auth())
        .send({
          categories: [{ name: 'Travel' }, { name: 'TRAVEL' }],
        })
        .expect(400);
      const names = (await listCategories()).map((c) => c.name.toLowerCase());
      expect(names).not.toContain('travel');
    });

    it('bulk rejects a name that already exists with 409', async () => {
      await postCategory('Gifts').expect(201);
      await http()
        .post(`${base()}/categories/bulk`)
        .set('Authorization', auth())
        .send({
          categories: [{ name: 'Charity' }, { name: 'gifts' }],
        })
        .expect(409);
    });
  });

  describe('sub-categories', () => {
    let categoryId: string;

    beforeAll(async () => {
      const res = await postCategory('Sub parent').expect(201);
      categoryId = (res.body as { id: string }).id;
    });

    it('rejects a case-insensitive duplicate within a category with 409', async () => {
      await postSubCategory(categoryId, 'apples').expect(201);
      await postSubCategory(categoryId, 'Apples').expect(409);
    });

    it('allows the same name in another category', async () => {
      const other = await postCategory('Sub other').expect(201);
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
});
