import { randomUUID } from 'node:crypto';
import { MikroORM, EntityManager, EntityRepository } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Household } from '../../entities/household.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { Category } from '../../entities/category.entity';
import { User } from '../../entities/user.entity';
import { AiRequest, AiRequestStatus } from '../../entities/ai-request.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { NotFoundException } from '@nestjs/common';
import { BillCrudService } from './bill-crud.service';
import { BillPhotoService } from './bill-photo.service';
import type { BillAiOrchestrator } from './bill-ai.orchestrator';
import { ParsedAndCategorizedBillSchema } from './tasks/schemas/parsed-and-categorized-bill.schema';
import type { ParsedBillResponseDto } from './dto/parsed-bill-response.dto';

jest.setTimeout(30_000);

// Model output -> schema -> BillPhotoService -> createDraftFromParsed against
// the real PostgreSQL schema: whatever the model returns, the INSERT holds.
describe('draft from AI output (PostgreSQL)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let userId: string;
  let householdId: string;
  let subCategoryId: string;

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
    em = orm.em.fork();

    const user = em.create(User, {
      first_name: 'Draft',
      email: `p07-draft-${randomUUID()}@example.com`,
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'P07 draft',
      created_by: user,
    } as never);
    const category = em.create(Category, {
      name: 'Food',
      household,
    } as never);
    const sub = em.create(SubCategory, { name: 'Bread', category } as never);
    await em.flush();
    userId = user.id;
    householdId = household.id;
    subCategoryId = sub.id;
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = em.getConnection();
    await conn.execute(
      'DELETE FROM bill_sub_categories WHERE bill_id IN (SELECT id FROM bills WHERE household_id = ?)',
      [householdId],
    );
    await conn.execute('DELETE FROM bills WHERE household_id = ?', [
      householdId,
    ]);
    await conn.execute('DELETE FROM ai_requests WHERE user_id = ?', [userId]);
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

  function crud(fork: EntityManager) {
    return new BillCrudService(
      fork.getRepository(Bill),
      fork.getRepository(Market),
      fork.getRepository(SubCategory),
      fork,
    );
  }

  async function loadDraft(id: string) {
    const fork = orm.em.fork();
    const bill = await fork.findOneOrFail(Bill, id);
    const items = await fork.find(BillSubCategory, { bill: id });
    return { bill, items };
  }

  it('saves a draft from a sloppy model answer with doubtful fields emptied', async () => {
    const modelAnswer = {
      market_name: 'Kaufland',
      bill_date: '07.05.2026',
      currency: 'LEI',
      total_amount: 12.5,
      items: [
        {
          name: 'x'.repeat(300),
          quantity: 1e12,
          unit: 'buc',
          weight_kg: null,
          price_per_kg: 1e9,
          final_price: 12.5,
          sub_category_id: 'not-a-uuid',
          category_confidence: 1.7,
          category_reasoning: 'n/a',
        },
      ],
    };
    const knownSub = {
      id: randomUUID(),
      name: 'bun',
      category: { name: 'Bread' },
    };
    const orchestrator = {
      parseAndCategorize: jest.fn().mockResolvedValue({
        data: ParsedAndCategorizedBillSchema.parse(modelAnswer),
        requestId: 'req-1',
      }),
    } as unknown as BillAiOrchestrator;
    const subRepo = {
      find: jest.fn().mockResolvedValue([knownSub]),
    } as unknown as EntityRepository<SubCategory>;
    const { parsed } = await new BillPhotoService(
      orchestrator,
      subRepo,
    ).parseAndCategorize(Buffer.from('x'), 'image/png', householdId, userId);

    const { id } = await crud(orm.em.fork()).createDraftFromParsed(
      householdId,
      userId,
      parsed,
    );

    const { bill, items } = await loadDraft(id);
    expect(bill.currency).toBeNull();
    expect(Number(bill.amount)).toBe(12.5);
    expect(items).toHaveLength(1);
    expect(items[0].raw_name).toBe('x'.repeat(255));
    expect(items[0].product_count).toBe(1);
    expect(items[0].unit).toBeNull();
    expect(items[0].price_per_unit).toBeNull();
    expect(items[0].sub_category).toBeNull();
  });

  it('saves a draft from a DTO that bypassed the schema', async () => {
    const parsed: ParsedBillResponseDto = {
      draft_id: '',
      market_name: null,
      bill_date: '07.05.2026',
      currency: 'eur',
      total_amount: 1e20,
      items: [
        {
          name: 'y'.repeat(300),
          quantity: 3e9,
          unit: 'kilograms' as never,
          weight_kg: 1e8,
          price_per_kg: 1e9,
          final_price: 1.5,
          sub_category: null,
          category_confidence: 1.7,
        },
      ],
    };

    const { id } = await crud(orm.em.fork()).createDraftFromParsed(
      householdId,
      userId,
      parsed,
    );

    const { bill, items } = await loadDraft(id);
    expect(bill.currency).toBe('EUR');
    expect(Number(bill.amount)).toBe(0);
    expect(items[0]).toMatchObject({
      raw_name: 'y'.repeat(255),
      product_count: 1,
      unit: null,
      product_weight: null,
      price_per_unit: null,
      category_confidence: null,
    });
  });

  async function aiRequest(): Promise<string> {
    const fork = orm.em.fork();
    const req = fork.create(AiRequest, {
      task_name: 'bill-parse-categorize',
      user: fork.getReference(User, userId),
      status: AiRequestStatus.SUCCESS,
      required_capabilities: ['vision'],
      image_s3_keys: ['ai/images/abc.jpg'],
      prompt: { messages: [] },
    } as never);
    await fork.flush();
    return req.id;
  }

  function parsedDto(
    overrides: Partial<ParsedBillResponseDto> = {},
  ): ParsedBillResponseDto {
    return {
      draft_id: '',
      market_name: 'Lidl',
      bill_date: '2026-05-07',
      currency: 'EUR',
      total_amount: 3.7,
      items: [
        {
          name: 'BREAD',
          quantity: 2,
          unit: 'piece',
          weight_kg: null,
          price_per_kg: null,
          final_price: 2.4,
          sub_category: null,
          category_confidence: 0.4,
          category_reasoning: 'Unsure.',
        },
        {
          name: 'TOMATOES',
          quantity: null,
          unit: 'kg',
          weight_kg: 0.5,
          price_per_kg: 2.6,
          final_price: 1.3,
          sub_category: null,
          category_confidence: 0,
        },
      ],
      ...overrides,
    };
  }

  describe('draft source and re-upload', () => {
    const sha = () => randomUUID().replace(/-/g, '').padEnd(64, '0');

    it('links the draft to its AI request and image hash', async () => {
      const aiRequestId = await aiRequest();
      const hash = sha();
      const { id, duplicate } = await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto(),
        {
          imageSha256: hash,
          aiRequestId,
        },
      );

      expect(duplicate).toBe(false);
      const { bill } = await loadDraft(id);
      expect(bill.image_sha256).toBe(hash);
      expect(bill.ai_request?.id).toBe(aiRequestId);
      expect(bill.bill_date_inferred).toBe(false);
    });

    it('flags a bill_date the model did not read', async () => {
      const { id } = await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto({ bill_date: null }),
      );
      const { bill } = await loadDraft(id);
      expect(bill.bill_date_inferred).toBe(true);
    });

    it('finds the open draft of the same image with all its items', async () => {
      const aiRequestId = await aiRequest();
      const hash = sha();
      const { id } = await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto({ bill_date: null }),
        { imageSha256: hash, aiRequestId },
      );

      const found = await crud(orm.em.fork()).findDraftByImageHash(
        householdId,
        hash,
      );

      expect(found?.requestId).toBe(aiRequestId);
      expect(found?.parsed).toMatchObject({
        draft_id: id,
        market_name: 'Lidl',
        bill_date: null,
        currency: 'EUR',
        total_amount: 3.7,
      });
      expect(found?.parsed.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'BREAD',
            quantity: 2,
            unit: 'piece',
            final_price: 2.4,
            category_confidence: 0.4,
            category_reasoning: 'Unsure.',
          }),
          expect.objectContaining({
            name: 'TOMATOES',
            quantity: null,
            unit: 'kg',
            weight_kg: 0.5,
            price_per_kg: 2.6,
            final_price: 1.3,
          }),
        ]),
      );
    });

    it('returns the read bill_date of a found draft as YYYY-MM-DD', async () => {
      const hash = sha();
      await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto(),
        { imageSha256: hash, aiRequestId: await aiRequest() },
      );
      const found = await crud(orm.em.fork()).findDraftByImageHash(
        householdId,
        hash,
      );
      expect(found?.parsed.bill_date).toBe('2026-05-07');
    });

    it('does not find the draft from another household', async () => {
      const hash = sha();
      await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto(),
        { imageSha256: hash, aiRequestId: await aiRequest() },
      );
      await expect(
        crud(orm.em.fork()).findDraftByImageHash(randomUUID(), hash),
      ).resolves.toBeNull();
    });

    it('does not find a confirmed or deleted bill of the same image', async () => {
      const confirmed = sha();
      const deleted = sha();
      for (const hash of [confirmed, deleted]) {
        await crud(orm.em.fork()).createDraftFromParsed(
          householdId,
          userId,
          parsedDto(),
          { imageSha256: hash, aiRequestId: await aiRequest() },
        );
      }
      const conn = orm.em.getConnection();
      await conn.execute(`UPDATE bills SET status = ? WHERE image_sha256 = ?`, [
        BillStatus.CONFIRMED,
        confirmed,
      ]);
      await conn.execute(
        `UPDATE bills SET deleted_at = now() WHERE image_sha256 = ?`,
        [deleted],
      );

      for (const hash of [confirmed, deleted]) {
        await expect(
          crud(orm.em.fork()).findDraftByImageHash(householdId, hash),
        ).resolves.toBeNull();
      }
    });

    it('returns the existing draft when the same image races in twice', async () => {
      const hash = sha();
      const first = await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto(),
        { imageSha256: hash, aiRequestId: await aiRequest() },
      );
      const second = await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto({ market_name: 'Other' }),
        { imageSha256: hash, aiRequestId: await aiRequest() },
      );

      expect(second).toEqual({ id: first.id, duplicate: true });
      const [{ count }] = (await orm.em
        .getConnection()
        .execute(`SELECT count(*) FROM bills WHERE image_sha256 = ?`, [
          hash,
        ])) as { count: string }[];
      expect(Number(count)).toBe(1);
    });
  });

  describe('reviewing drafts', () => {
    it('keeps two items of one sub-category as separate lines', async () => {
      const sub = { id: subCategoryId, name: 'Bread', category_name: 'Food' };
      const item = parsedDto().items[1];
      const { id } = await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto({
          total_amount: 8,
          items: [
            {
              ...item,
              name: 'TOMATOES',
              weight_kg: 2,
              price_per_kg: 2.5,
              final_price: 5,
              sub_category: sub,
            },
            {
              ...item,
              name: 'CUCUMBERS',
              weight_kg: 1,
              price_per_kg: 3,
              final_price: 3,
              sub_category: sub,
            },
          ],
        }),
      );

      const draft = await crud(orm.em.fork()).getBill(id, householdId);

      expect(draft.items).toHaveLength(2);
      expect(draft.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            raw_name: 'TOMATOES',
            amount: 5,
            product_weight: 2,
            price_per_unit: 2.5,
          }),
          expect.objectContaining({
            raw_name: 'CUCUMBERS',
            amount: 3,
            product_weight: 1,
            price_per_unit: 3,
          }),
        ]),
      );
      expect(draft.items.every((i) => typeof i.id === 'string')).toBe(true);
    });

    it('reopens a draft with every item as the model read it', async () => {
      const { id } = await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto({ bill_date: null }),
      );

      const draft = await crud(orm.em.fork()).getBill(id, householdId);

      expect(draft).toMatchObject({
        id,
        status: BillStatus.DRAFT,
        market_name_raw: 'Lidl',
        bill_date_inferred: true,
        total_amount: 3.7,
      });
      expect(draft.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            raw_name: 'BREAD',
            unit: 'piece',
            product_count: 2,
            amount: 2.4,
            category_confidence: 0.4,
            category_reasoning: 'Unsure.',
          }),
          expect.objectContaining({
            raw_name: 'TOMATOES',
            unit: 'kg',
            product_weight: 0.5,
            price_per_unit: 2.6,
          }),
        ]),
      );
    });

    it.each([
      [
        'updated',
        (svc: BillCrudService, id: string) =>
          svc.updateBill(id, householdId, { bill_date: '2026-05-01' }),
      ],
      [
        'confirmed',
        (svc: BillCrudService, id: string) =>
          svc.confirmBill(id, householdId, userId, {
            bill_date: '2026-05-01',
            total_amount: 1,
            items: [
              { sub_category_id: subCategoryId, product_count: 1, amount: 1 },
            ],
          }),
      ],
    ])(
      'stops flagging the date once the user %s it',
      async (_label, setDate) => {
        const { id } = await crud(orm.em.fork()).createDraftFromParsed(
          householdId,
          userId,
          parsedDto({ bill_date: null }),
        );

        await setDate(crud(orm.em.fork()), id);

        const { bill } = await loadDraft(id);
        expect(bill.bill_date_inferred).toBe(false);
      },
    );

    it('lists drafts newest first, a page at a time, with their items', async () => {
      const fork = orm.em.fork();
      const other = fork.create(Household, {
        name: 'P14 drafts list',
        created_by: fork.getReference(User, userId),
      } as never);
      await fork.flush();
      const ids: string[] = [];
      for (const market of ['A', 'B', 'C']) {
        const { id } = await crud(orm.em.fork()).createDraftFromParsed(
          other.id,
          userId,
          parsedDto({ market_name: market }),
        );
        ids.push(id);
      }
      // Distinct creation times regardless of clock resolution.
      await orm.em
        .getConnection()
        .execute(
          `UPDATE bills SET created_at = now() - (interval '1 minute' * array_position(?::uuid[], id)) WHERE household_id = ?`,
          [`{${[...ids].reverse().join(',')}}`, other.id],
        );

      try {
        const page1 = await crud(orm.em.fork()).listDrafts(other.id, {
          page: 1,
          limit: 2,
        });
        const page2 = await crud(orm.em.fork()).listDrafts(other.id, {
          page: 2,
          limit: 2,
        });

        expect(page1.meta).toEqual({
          total: 3,
          page: 1,
          limit: 2,
          total_pages: 2,
        });
        expect(page1.data.map((d) => d.market_name_raw)).toEqual(['C', 'B']);
        expect(page2.data.map((d) => d.market_name_raw)).toEqual(['A']);
        expect(page1.data[0].items).toHaveLength(2);
        expect(page1.data[0].status).toBe(BillStatus.DRAFT);
      } finally {
        const conn = orm.em.getConnection();
        await conn.execute(
          'DELETE FROM bill_sub_categories WHERE bill_id IN (SELECT id FROM bills WHERE household_id = ?)',
          [other.id],
        );
        await conn.execute('DELETE FROM bills WHERE household_id = ?', [
          other.id,
        ]);
        await conn.execute('DELETE FROM households WHERE id = ?', [other.id]);
      }
    });
  });

  describe('draft image', () => {
    async function draftWithImage(): Promise<string> {
      const { id } = await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto(),
        {
          imageSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          aiRequestId: await aiRequest(),
        },
      );
      return id;
    }

    it('gives the stored image key of a draft of this household', async () => {
      const id = await draftWithImage();
      await expect(
        crud(orm.em.fork()).getDraftImageKey(id, householdId),
      ).resolves.toBe('ai/images/abc.jpg');
    });

    it('hides the draft of another household', async () => {
      const id = await draftWithImage();
      await expect(
        crud(orm.em.fork()).getDraftImageKey(id, randomUUID()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('has no image for a confirmed bill or a manual draft', async () => {
      const confirmed = await draftWithImage();
      await orm.em
        .getConnection()
        .execute(`UPDATE bills SET status = ? WHERE id = ?`, [
          BillStatus.CONFIRMED,
          confirmed,
        ]);
      const { id: manual } = await crud(orm.em.fork()).createDraftFromParsed(
        householdId,
        userId,
        parsedDto(),
      );

      for (const id of [confirmed, manual]) {
        await expect(
          crud(orm.em.fork()).getDraftImageKey(id, householdId),
        ).rejects.toBeInstanceOf(NotFoundException);
      }
    });
  });
});
