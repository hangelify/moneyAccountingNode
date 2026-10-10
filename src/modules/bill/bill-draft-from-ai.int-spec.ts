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
import { User } from '../../entities/user.entity';
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
    await em.flush();
    userId = user.id;
    householdId = household.id;
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

    const id = await crud(orm.em.fork()).createDraftFromParsed(
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

    const id = await crud(orm.em.fork()).createDraftFromParsed(
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
});
