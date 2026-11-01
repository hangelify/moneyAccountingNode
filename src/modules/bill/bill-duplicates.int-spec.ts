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
import { BillDuplicatesService } from './bill-duplicates.service';
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
