import { randomUUID } from 'node:crypto';
import { MikroORM, EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Category } from '../../entities/category.entity';
import { Household } from '../../entities/household.entity';
import { PlaningHorizon } from '../../entities/planing-horizon.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { User } from '../../entities/user.entity';
import { CategoryService } from './category.service';
import { SubCategoryService } from '../sub-category/sub-category.service';
import { BillPhotoService } from '../bill/bill-photo.service';
import type { BillAiOrchestrator } from '../bill/bill-ai.orchestrator';

jest.setTimeout(30_000);

// Sub-categories of a soft-deleted category must be gone everywhere: the
// delete marks them too, and lookups check the parent's deleted_at as well.
describe('soft delete of categories and their sub-categories (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  let householdId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: PostgreSqlDriver,
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432', 10),
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
          dbName: process.env.DB_NAME || 'accounting',
          entities: ['./dist/**/*.entity.js'],
          entitiesTs: ['./src/**/*.entity.ts'],
          allowGlobalContext: true,
        }),
      ],
    }).compile();
    orm = mod.get(MikroORM);

    const em = orm.em.fork();
    const user = em.create(User, {
      first_name: 'SoftDelete',
      email: `p15-soft-delete-${randomUUID()}@example.com`,
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'P15 soft delete',
      created_by: user,
    } as never);
    await em.flush();
    userId = user.id;
    householdId = household.id;
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = orm.em.getConnection();
    await conn.execute(
      'DELETE FROM sub_categories WHERE category_id IN (SELECT id FROM categories WHERE household_id = ?)',
      [householdId],
    );
    await conn.execute('DELETE FROM categories WHERE household_id = ?', [
      householdId,
    ]);
    await conn.execute('DELETE FROM households WHERE id = ?', [householdId]);
    await conn.execute('DELETE FROM users WHERE id = ?', [userId]);
    await orm.close(true);
  });

  function categoryService(em: EntityManager) {
    return new CategoryService(
      em.getRepository(Category),
      em.getRepository(PlaningHorizon),
      em,
    );
  }

  function subCategoryService(em: EntityManager) {
    return new SubCategoryService(
      em.getRepository(SubCategory),
      em.getRepository(Category),
      em,
    );
  }

  /** A live category with two live sub-categories. */
  async function makeTree(label: string) {
    const em = orm.em.fork();
    const category = em.create(Category, {
      name: `${label} category`,
      household: householdId,
    } as never);
    const subs = ['a', 'b'].map((s) =>
      em.create(SubCategory, {
        name: `${label} sub ${s}`,
        category,
      } as never),
    );
    await em.flush();
    return { categoryId: category.id, subIds: subs.map((s) => s.id) };
  }

  /** Soft-deletes the category row only, as the code before the cascade did. */
  async function markCategoryDeleted(categoryId: string) {
    await orm.em
      .fork()
      .nativeUpdate(Category, { id: categoryId }, { deleted_at: new Date() });
  }

  it('deleteCategory marks its sub-categories deleted', async () => {
    const { categoryId, subIds } = await makeTree('cascade');
    const other = await makeTree('untouched');

    await categoryService(orm.em.fork()).deleteCategory(
      categoryId,
      householdId,
    );

    const subs = await orm.em
      .fork()
      .find(SubCategory, { id: { $in: [...subIds, ...other.subIds] } });
    const deletedAt = new Map(subs.map((s) => [s.id, s.deleted_at]));
    for (const id of subIds) expect(deletedAt.get(id)).toBeInstanceOf(Date);
    for (const id of other.subIds) expect(deletedAt.get(id)).toBeNull();
  });

  it('deleteCategory keeps the earlier deleted_at of an already deleted sub-category', async () => {
    const { categoryId, subIds } = await makeTree('earlier');
    const earlier = new Date('2026-01-01T00:00:00Z');
    await orm.em
      .fork()
      .nativeUpdate(SubCategory, { id: subIds[0] }, { deleted_at: earlier });

    await categoryService(orm.em.fork()).deleteCategory(
      categoryId,
      householdId,
    );

    const sub = await orm.em.fork().findOneOrFail(SubCategory, subIds[0]);
    expect(sub.deleted_at).toEqual(earlier);
  });

  describe('a live sub-category of a deleted category', () => {
    let subId: string;

    beforeEach(async () => {
      const { categoryId, subIds } = await makeTree(`orphan-${randomUUID()}`);
      await markCategoryDeleted(categoryId);
      subId = subIds[0];
    });

    it('GET returns 404', async () => {
      await expect(
        subCategoryService(orm.em.fork()).getSubCategory(subId, householdId),
      ).rejects.toThrow(NotFoundException);
    });

    it('PUT returns 404 and changes nothing', async () => {
      await expect(
        subCategoryService(orm.em.fork()).updateSubCategory(
          subId,
          householdId,
          { name: 'renamed' },
        ),
      ).rejects.toThrow(NotFoundException);
      const sub = await orm.em.fork().findOneOrFail(SubCategory, subId);
      expect(sub.name).not.toBe('renamed');
    });

    it('DELETE returns 404', async () => {
      await expect(
        subCategoryService(orm.em.fork()).softDeleteSubCategory(
          subId,
          householdId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('is not offered to the model on parse-photo', async () => {
      const live = await makeTree(`live-${randomUUID()}`);
      const orchestrator = {
        parseAndCategorize: jest.fn().mockResolvedValue({
          data: {
            market_name: null,
            bill_date: null,
            currency: null,
            total_amount: 0,
            items: [],
          },
          requestId: 'req-1',
        }),
        parseOnly: jest.fn(),
      } as unknown as BillAiOrchestrator;
      const em = orm.em.fork();

      await new BillPhotoService(
        orchestrator,
        em.getRepository(SubCategory),
      ).parseAndCategorize(Buffer.from('x'), 'image/png', householdId, userId);

      const calls = (orchestrator.parseAndCategorize as jest.Mock).mock
        .calls as unknown[][];
      expect(calls).toHaveLength(1);
      const offered = (calls[0][3] as Array<{ id: string }>).map((s) => s.id);
      expect(offered).toEqual(expect.arrayContaining(live.subIds));
      expect(offered).not.toContain(subId);
    });
  });
});
