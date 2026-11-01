import { MikroORM, EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { Household } from '../../entities/household.entity';
import { Market } from '../../entities/market.entity';
import { User } from '../../entities/user.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { Currency } from '../../types/currency.enum';
import { BillCrudService } from './bill-crud.service';
import { BillDuplicatesService } from './bill-duplicates.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { StubProvider } from '../exchange-rate/testing/stub-exchange-rate.provider';
import { BillConversionService } from './household-conversion';
import { SubCategory } from '../../entities/sub-category.entity';
import type { DuplicateProbe } from './bill-duplicates';

describe('BillDuplicatesService (PostgreSQL)', () => {
  let orm: MikroORM;
  let service: BillDuplicatesService;
  let householdId: string;
  const ids: Record<string, string> = {};

  const probe: DuplicateProbe = {
    amount: 100,
    currency: Currency.MDL,
    bill_date: '2026-10-03',
    market_id: null,
    market_name: null,
    fiscal_register_id: null,
    fiscal_receipt_number: null,
    purchase_time: null,
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          ...createMikroOrmConfig(),
          allowGlobalContext: true,
        }),
      ],
      providers: [BillDuplicatesService],
    }).compile();
    orm = mod.get(MikroORM);
    service = mod.get(BillDuplicatesService);

    const em: EntityManager = orm.em.fork();
    const ana = em.create(User, {
      first_name: 'Ana',
      email: 'bill-duplicates@example.com',
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Dups',
      currency: Currency.MDL,
      created_by: ana,
    } as never);
    const other = em.create(Household, {
      name: 'Dups other',
      currency: Currency.MDL,
      created_by: ana,
    } as never);
    const linella = em.create(Market, {
      name: 'Linella',
      city: 'Chisinau',
      household,
    } as never);

    const created: Record<string, Bill> = {};
    const bill = (key: string, data: Record<string, unknown>) => {
      const b = em.create(Bill, {
        household,
        created_by: ana,
        status: BillStatus.CONFIRMED,
        currency: Currency.MDL,
        bill_date: '2026-10-03',
        amount: 100,
        ...data,
      } as never);
      created[key] = b;
      return b;
    };

    bill('fiscal', {
      amount: 412.5,
      bill_date: '2026-09-01',
      fiscal_register_id: 'J4030',
      fiscal_receipt_number: '0042',
      market: linella,
    });
    const original = bill('original', { market_name_raw: 'Corner shop' });
    await em.flush();
    bill('draft', { status: BillStatus.DRAFT });
    bill('duplicate', {
      status: BillStatus.DUPLICATE,
      duplicate_of: original,
    });
    bill('deleted', { deleted_at: new Date() });
    bill('foreign', { household: other });
    await em.flush();
    for (const [key, b] of Object.entries(created)) ids[key] = b.id;
    householdId = household.id;
  });

  afterAll(async () => {
    await orm.close();
  });

  it('finds a confirmed bill by fiscal ids across different amounts', async () => {
    const found = await service.findCandidates(householdId, {
      ...probe,
      amount: 41.25,
      bill_date: '2026-10-20',
      fiscal_register_id: ' j4030',
      fiscal_receipt_number: '0042 ',
    });
    expect(found).toEqual([
      {
        id: ids.fiscal,
        bill_date: '2026-09-01',
        total_amount: 412.5,
        currency: Currency.MDL,
        market_name: 'Linella',
        created_by_name: 'Ana',
        match: 'fiscal',
      },
    ]);
  });

  it('ignores drafts, duplicates, deleted bills, other households and excludeBillId', async () => {
    const found = await service.findCandidates(householdId, probe);
    expect(found.map((f) => f.id)).toEqual([ids.original]);
    const excluded = await service.findCandidates(householdId, probe, {
      excludeBillId: ids.original,
    });
    expect(excluded).toEqual([]);
  });

  it('returns created_by_name and market_name', async () => {
    const [found] = await service.findCandidates(householdId, {
      ...probe,
      market_name: 'corner SHOP',
    });
    expect(found).toMatchObject({
      id: ids.original,
      market_name: 'Corner shop',
      created_by_name: 'Ana',
      total_amount: 100,
      match: 'strong',
    });
  });

  it('respects the date tolerance in SQL', async () => {
    const near = { ...probe, bill_date: '2026-10-04' };
    expect(await service.findCandidates(householdId, near)).toEqual([]);
    const found = await service.findCandidates(householdId, near, {
      dateToleranceDays: 1,
    });
    expect(found.map((f) => f.id)).toEqual([ids.original]);
  });
});

describe('possible duplicates on bill reads and writes (PostgreSQL)', () => {
  let orm: MikroORM;
  let householdId: string;
  let userId: string;
  const ids: Record<string, string> = {};

  function crud() {
    const fork = orm.em.fork();
    const rates = new ExchangeRateService(fork, new StubProvider());
    return new BillCrudService(
      fork.getRepository(Bill),
      fork.getRepository(Market),
      fork.getRepository(SubCategory),
      fork,
      rates,
      new BillConversionService(fork, rates),
      new BillDuplicatesService(fork),
    );
  }

  async function draft(data: Record<string, unknown>): Promise<string> {
    const fork = orm.em.fork();
    const b = fork.create(Bill, {
      household: householdId,
      created_by: userId,
      status: BillStatus.DRAFT,
      currency: Currency.MDL,
      bill_date: '2026-10-03',
      amount: 77,
      ...data,
    } as never);
    await fork.flush();
    return b.id;
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          ...createMikroOrmConfig(),
          allowGlobalContext: true,
        }),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    const em = orm.em.fork();
    const ana = em.create(User, {
      first_name: 'Ana',
      email: 'bill-duplicates-reads@example.com',
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Dups reads',
      currency: Currency.MDL,
      created_by: ana,
    } as never);
    const original = em.create(Bill, {
      household,
      created_by: ana,
      status: BillStatus.CONFIRMED,
      currency: Currency.MDL,
      bill_date: '2026-10-03',
      amount: 77,
      market_name_raw: 'Corner shop',
    } as never);
    await em.flush();
    householdId = household.id;
    userId = ana.id;
    ids.original = original.id;
    ids.dupe = await draft({
      status: BillStatus.DUPLICATE,
      duplicate_of: original,
    });
  });

  afterAll(async () => {
    await orm.close();
  });

  it('getBill of a draft lists confirmed look-alikes', async () => {
    const id = await draft({});
    const res = await crud().getBill(id, householdId);
    expect(res.duplicate_of).toBeNull();
    expect(res.possible_duplicates).toEqual([
      expect.objectContaining({
        id: ids.original,
        total_amount: 77,
        market_name: 'Corner shop',
        created_by_name: 'Ana',
        match: 'weak',
      }),
    ]);
  });

  it('getBill of a duplicate returns duplicate_of and no candidates', async () => {
    const res = await crud().getBill(ids.dupe, householdId);
    expect(res.possible_duplicates).toEqual([]);
    expect(res.duplicate_of).toEqual({
      id: ids.original,
      bill_date: '2026-10-03',
      total_amount: 77,
      currency: Currency.MDL,
      market_name: 'Corner shop',
      created_by_name: 'Ana',
    });
  });

  it('createBill returns possible_duplicates and still saves the bill as confirmed', async () => {
    const res = await crud().createBill(householdId, userId, {
      bill_date: '2026-10-03',
      total_amount: 77,
      currency: Currency.MDL,
      items: [],
    });
    expect(res.status).toBe(BillStatus.CONFIRMED);
    expect(res.duplicate_of).toBeNull();
    expect(res.possible_duplicates?.map((d) => d.id)).toEqual([ids.original]);
    const saved = await orm.em.fork().findOneOrFail(Bill, res.id);
    expect(saved.status).toBe(BillStatus.CONFIRMED);
  });

  it('confirmBill returns possible_duplicates excluding itself', async () => {
    const id = await draft({});
    const res = await crud().confirmBill(id, householdId, userId, {
      bill_date: '2026-10-03',
      total_amount: 77,
      currency: Currency.MDL,
      items: [],
    });
    expect(res.status).toBe(BillStatus.CONFIRMED);
    const found = res.possible_duplicates?.map((d) => d.id) ?? [];
    expect(found).toContain(ids.original);
    expect(found).not.toContain(id);
  });
});
