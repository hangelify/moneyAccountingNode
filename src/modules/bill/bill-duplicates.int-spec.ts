import { randomUUID } from 'node:crypto';
import { MikroORM, EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { BillDashboardService } from './bill-dashboard.service';
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

describe('marking duplicates (PostgreSQL)', () => {
  let orm: MikroORM;
  let householdId: string;
  let otherHouseholdId: string;
  let userId: string;
  let foreignBillId: string;

  function services() {
    const fork = orm.em.fork();
    const rates = new ExchangeRateService(fork, new StubProvider());
    const duplicates = new BillDuplicatesService(fork);
    const crud = new BillCrudService(
      fork.getRepository(Bill),
      fork.getRepository(Market),
      fork.getRepository(SubCategory),
      fork,
      rates,
      new BillConversionService(fork, rates),
      duplicates,
    );
    return {
      crud,
      duplicates,
      dashboard: new BillDashboardService(fork, rates),
    };
  }
  const crud = () => services().crud;
  const mark = (id: string, of: string) =>
    services().duplicates.markDuplicate(id, householdId, of);

  async function bill(data: Record<string, unknown> = {}): Promise<string> {
    const fork = orm.em.fork();
    const b = fork.create(Bill, {
      household: householdId,
      created_by: userId,
      status: BillStatus.CONFIRMED,
      currency: Currency.MDL,
      bill_date: '2026-10-03',
      amount: 100,
      ...data,
    } as never);
    await fork.flush();
    return b.id;
  }

  async function load(id: string) {
    const b = await orm.em.fork().findOneOrFail(Bill, id);
    return { status: b.status, of: b.duplicate_of?.id ?? null };
  }

  const required = {
    bill_date: '2026-10-03',
    total_amount: 100,
    currency: Currency.MDL,
  };

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
      email: 'bill-duplicates-mark@example.com',
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Dups mark',
      currency: Currency.MDL,
      created_by: ana,
    } as never);
    const other = em.create(Household, {
      name: 'Dups mark other',
      currency: Currency.MDL,
      created_by: ana,
    } as never);
    const foreign = em.create(Bill, {
      household: other,
      created_by: ana,
      status: BillStatus.CONFIRMED,
      currency: Currency.MDL,
      bill_date: '2026-10-03',
      amount: 100,
    } as never);
    await em.flush();
    householdId = household.id;
    otherHouseholdId = other.id;
    userId = ana.id;
    foreignBillId = foreign.id;
  });

  afterAll(async () => {
    await orm.close();
  });

  it('marks a confirmed bill as a duplicate and counts the purchase once', async () => {
    const a = await bill({ amount: 40, bill_date: '2026-11-10' });
    const b = await bill({ amount: 40, bill_date: '2026-11-10' });
    const total = async () => {
      const res = await services().dashboard.getDashboard(householdId, {
        type: 'month',
        year: 2026,
        month: 11,
      });
      const series = res.by_currency.find((s) => s.currency === Currency.MDL)!;
      return series.period_totals.reduce((sum, p) => sum + p.total, 0);
    };
    expect(await total()).toBe(80);

    await mark(b, a);

    expect(await load(b)).toEqual({ status: BillStatus.DUPLICATE, of: a });
    expect(await load(a)).toEqual({ status: BillStatus.CONFIRMED, of: null });
    expect(await total()).toBe(40);
  });

  it('links to the original when the target is itself a duplicate', async () => {
    const a = await bill();
    const b = await bill();
    const c = await bill();
    await mark(b, a);

    await mark(c, b);

    expect(await load(c)).toEqual({ status: BillStatus.DUPLICATE, of: a });
  });

  it("re-points this bill's duplicates to the new original", async () => {
    const a = await bill();
    const b = await bill();
    const c = await bill();
    const deletedChild = await bill();
    await mark(c, b);
    await mark(deletedChild, b);
    await orm.em
      .fork()
      .getConnection()
      .execute('UPDATE bills SET deleted_at = now() WHERE id = ?', [
        deletedChild,
      ]);

    await mark(b, a);

    expect(await load(b)).toEqual({ status: BillStatus.DUPLICATE, of: a });
    expect(await load(c)).toEqual({ status: BillStatus.DUPLICATE, of: a });
    expect(await load(deletedChild)).toEqual({
      status: BillStatus.DUPLICATE,
      of: a,
    });
  });

  it('refuses a cycle and leaves both bills unchanged', async () => {
    const a = await bill();
    const b = await bill();
    await mark(a, b);

    await expect(mark(b, a)).rejects.toBeInstanceOf(BadRequestException);

    expect(await load(a)).toEqual({ status: BillStatus.DUPLICATE, of: b });
    expect(await load(b)).toEqual({ status: BillStatus.CONFIRMED, of: null });
  });

  it('refuses self (400), a draft bill (409), a deleted or other-household target (404)', async () => {
    const a = await bill();
    const draft = await bill({ status: BillStatus.DRAFT });
    const deleted = await bill({ deleted_at: new Date() });

    await expect(mark(a, a)).rejects.toBeInstanceOf(BadRequestException);
    await expect(mark(draft, a)).rejects.toBeInstanceOf(ConflictException);
    await expect(mark(a, deleted)).rejects.toBeInstanceOf(NotFoundException);
    await expect(mark(a, foreignBillId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(mark(a, randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(mark(foreignBillId, a)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(mark(a, draft)).rejects.toBeInstanceOf(BadRequestException);
    expect(await load(a)).toEqual({ status: BillStatus.CONFIRMED, of: null });
    expect(otherHouseholdId).toBeDefined();
  });

  it('refuses to mark a bill that is already a duplicate', async () => {
    const a = await bill();
    const b = await bill();
    const c = await bill();
    await mark(b, a);

    await expect(mark(b, c)).rejects.toBeInstanceOf(ConflictException);
    expect(await load(b)).toEqual({ status: BillStatus.DUPLICATE, of: a });
  });

  it('unmark returns the bill to confirmed', async () => {
    const a = await bill();
    const b = await bill();
    await mark(b, a);

    await services().duplicates.unmarkDuplicate(b, householdId);

    expect(await load(b)).toEqual({ status: BillStatus.CONFIRMED, of: null });
  });

  it('unmark of a confirmed bill is 400, of a missing bill 404', async () => {
    const a = await bill();
    const { duplicates } = services();

    await expect(
      duplicates.unmarkDuplicate(a, householdId),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      duplicates.unmarkDuplicate(randomUUID(), householdId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('confirm with duplicate_of_id saves a duplicate', async () => {
    const original = await bill();
    const draft = await bill({ status: BillStatus.DRAFT });

    const res = await crud().confirmBill(draft, householdId, userId, {
      ...required,
      items: [],
      duplicate_of_id: original,
    });

    expect(res.status).toBe(BillStatus.DUPLICATE);
    expect(res.duplicate_of?.id).toBe(original);
    expect(await load(draft)).toEqual({
      status: BillStatus.DUPLICATE,
      of: original,
    });
  });

  it('create with duplicate_of_id saves a duplicate', async () => {
    const original = await bill();

    const res = await crud().createBill(householdId, userId, {
      ...required,
      items: [],
      duplicate_of_id: original,
    });

    expect(res.status).toBe(BillStatus.DUPLICATE);
    expect(res.duplicate_of?.id).toBe(original);
    expect(await load(res.id)).toEqual({
      status: BillStatus.DUPLICATE,
      of: original,
    });
  });

  it('create with a bad duplicate_of_id saves nothing', async () => {
    const before = await orm.em.fork().count(Bill, { household: householdId });

    await expect(
      crud().createBill(householdId, userId, {
        ...required,
        items: [],
        duplicate_of_id: foreignBillId,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(await orm.em.fork().count(Bill, { household: householdId })).toBe(
      before,
    );
  });

  it('confirm with a bad duplicate_of_id rolls back', async () => {
    const fork = orm.em.fork();
    const draftBill = fork.create(Bill, {
      household: householdId,
      created_by: userId,
      status: BillStatus.DRAFT,
      bill_date: '2026-10-03',
      amount: 10,
    } as never);
    fork.create(BillSubCategory, {
      bill: draftBill,
      raw_name: 'LAPTE 1L',
      product_count: 2,
      amount: 10,
    } as never);
    await fork.flush();

    await expect(
      crud().confirmBill(draftBill.id, householdId, userId, {
        ...required,
        items: [{ raw_name: 'PAINE', product_count: 1, amount: 1 }],
        duplicate_of_id: foreignBillId,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const check = orm.em.fork();
    const saved = await check.findOneOrFail(Bill, draftBill.id);
    expect(saved.status).toBe(BillStatus.DRAFT);
    expect(saved.confirmed_at).toBeNull();
    const lines = await check.find(BillSubCategory, { bill: draftBill.id });
    expect(lines.map((l) => l.raw_name)).toEqual(['LAPTE 1L']);
  });

  it('editing a duplicate keeps it a duplicate', async () => {
    const a = await bill();
    const b = await bill();
    await mark(b, a);

    await crud().updateBill(b, householdId, { description: 'edited' });

    const saved = await orm.em.fork().findOneOrFail(Bill, b);
    expect(saved.description).toBe('edited');
    expect(saved.status).toBe(BillStatus.DUPLICATE);
    expect(saved.duplicate_of?.id).toBe(a);
  });

  describe('deleting an original', () => {
    const monthTotal = async () => {
      const res = await services().dashboard.getDashboard(householdId, {
        type: 'month',
        year: 2026,
        month: 12,
      });
      const series = res.by_currency.find((s) => s.currency === Currency.MDL);
      return (series?.period_totals ?? []).reduce((sum, p) => sum + p.total, 0);
    };
    // The beforeCreate hook stamps created_at, so pin it for a stable order.
    const dated = async (n: number) => {
      const id = await bill({ amount: 60, bill_date: '2026-12-05' });
      await orm.em
        .fork()
        .getConnection()
        .execute('UPDATE bills SET created_at = ? WHERE id = ?', [
          new Date(Date.UTC(2026, 11, 5, 10, n)),
          id,
        ]);
      return id;
    };

    it('promotes the oldest duplicate and re-points the rest', async () => {
      const before = await monthTotal();
      const a = await dated(0);
      const c = await dated(2);
      const b = await dated(1);
      await mark(c, a);
      await mark(b, a);
      expect(await monthTotal()).toBe(before + 60);

      await crud().softDeleteBill(a, householdId);

      expect(await load(b)).toEqual({ status: BillStatus.CONFIRMED, of: null });
      expect(await load(c)).toEqual({ status: BillStatus.DUPLICATE, of: b });
      expect(await monthTotal()).toBe(before + 60);
    });

    it('never promotes a deleted duplicate', async () => {
      const before = await monthTotal();
      const a = await dated(0);
      const b = await dated(1);
      const c = await dated(2);
      await mark(b, a);
      await mark(c, a);
      await crud().softDeleteBill(b, householdId);

      await crud().softDeleteBill(a, householdId);

      expect(await load(c)).toEqual({ status: BillStatus.CONFIRMED, of: null });
      expect(await load(b)).toEqual({ status: BillStatus.DUPLICATE, of: c });
      expect(await monthTotal()).toBe(before + 60);
    });

    it('leaves the original alone when a duplicate is deleted', async () => {
      const before = await monthTotal();
      const a = await dated(0);
      const b = await dated(1);
      await mark(b, a);

      await crud().softDeleteBill(b, householdId);

      expect(await load(a)).toEqual({ status: BillStatus.CONFIRMED, of: null });
      expect(await monthTotal()).toBe(before + 60);
    });
  });
});
