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
import { BillParseErrorCode } from '../../types/bill-parse-error.enum';
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
import { Category } from '../../entities/category.entity';
import { SpendingBreakdownService } from './spending-breakdown.service';
import { MarketService } from '../market/market.service';

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

  it('rounds the probe amount to cents', async () => {
    const found = await service.findCandidates(householdId, {
      ...probe,
      amount: 100.004,
    });
    expect(found.map((f) => f.id)).toEqual([ids.original]);
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
      new MarketService(fork.getRepository(Market), fork),
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

  it('a dismissed pair no longer lists each other on bill reads', async () => {
    const a = await draft({ status: BillStatus.CONFIRMED, amount: 78 });
    const b = await draft({ status: BillStatus.CONFIRMED, amount: 78 });
    const c = await draft({ status: BillStatus.CONFIRMED, amount: 78 });
    const idsOf = async (id: string) =>
      (await crud().getBill(id, householdId)).possible_duplicates
        ?.map((d) => d.id)
        .sort();
    expect(await idsOf(a)).toEqual([b, c].sort());

    await new BillDuplicatesService(orm.em.fork()).dismiss(
      a,
      householdId,
      userId,
      b,
    );

    expect(await idsOf(a)).toEqual([c]);
    expect(await idsOf(b)).toEqual([c]);
  });

  it('an inferred-date draft matches by fiscal ids only', async () => {
    const weak = await draft({
      status: BillStatus.CONFIRMED,
      amount: 79,
      bill_date: '2026-10-04',
    });
    const fiscal = await draft({
      status: BillStatus.CONFIRMED,
      amount: 5,
      bill_date: '2026-09-01',
      fiscal_register_id: 'R9',
      fiscal_receipt_number: '9',
    });
    const inferred = await draft({
      amount: 79,
      bill_date: '2026-10-04',
      bill_date_inferred: true,
      fiscal_register_id: 'r9',
      fiscal_receipt_number: '9',
    });
    const plain = await draft({ amount: 79, bill_date: '2026-10-04' });

    const found = (await crud().getBill(inferred, householdId))
      .possible_duplicates;
    expect(found?.map((d) => [d.id, d.match])).toEqual([[fiscal, 'fiscal']]);
    // The same draft with a trusted date still weak-matches.
    const trusted = (await crud().getBill(plain, householdId))
      .possible_duplicates;
    expect(trusted?.map((d) => d.id)).toContain(weak);
  });

  it('a failed bill with an inferred date is not weak-matched to confirmed bills', async () => {
    const confirmed = await draft({
      status: BillStatus.CONFIRMED,
      amount: 0,
      bill_date: '2026-10-05',
    });
    const failed = await draft({
      status: BillStatus.FAILED,
      amount: 0,
      bill_date: '2026-10-05',
      bill_date_inferred: true,
      parse_error_code: BillParseErrorCode.AI_FAILED,
      parse_error_message: 'Processing failed; retry later',
    });

    const found = (await crud().getBill(failed, householdId))
      .possible_duplicates;
    expect(found?.map((d) => d.id)).not.toContain(confirmed);
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
      new MarketService(fork.getRepository(Market), fork),
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

  it('re-pointing a duplicate advances its updated_at', async () => {
    const a = await bill();
    const b = await bill();
    const c = await bill();
    await mark(c, b);
    const stamp = async () =>
      (await orm.em.fork().findOneOrFail(Bill, c)).updated_at.getTime();
    const before = await stamp();

    await mark(b, a);

    expect(await stamp()).toBeGreaterThan(before);
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

    it('re-pointing on promotion advances updated_at', async () => {
      const a = await dated(0);
      const b = await dated(1);
      const c = await dated(2);
      await mark(b, a);
      await mark(c, a);
      const stamp = async () =>
        (await orm.em.fork().findOneOrFail(Bill, c)).updated_at.getTime();
      const before = await stamp();

      await crud().softDeleteBill(a, householdId);

      expect(await stamp()).toBeGreaterThan(before);
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

describe('duplicate suggestions (PostgreSQL)', () => {
  let orm: MikroORM;
  let householdId: string;
  let otherHouseholdId: string;
  let userId: string;

  const service = () => new BillDuplicatesService(orm.em.fork());
  const suggest = (query: { date_from?: string; date_to?: string } = {}) =>
    service().suggestions(householdId, query);
  const dismiss = (id: string, other: string, hid = householdId) =>
    service().dismiss(id, hid, userId, other);

  async function bill(
    data: Record<string, unknown> = {},
    hid = householdId,
  ): Promise<string> {
    const fork = orm.em.fork();
    const b = fork.create(Bill, {
      household: hid,
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
  const idsOf = (res: Awaited<ReturnType<typeof suggest>>) =>
    res.pairs.map((p) => [p.bill.id, p.other.id]);
  const sorted = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

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
      email: 'bill-duplicates-suggest@example.com',
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Dups suggest',
      currency: Currency.MDL,
      created_by: ana,
    } as never);
    const other = em.create(Household, {
      name: 'Dups suggest other',
      currency: Currency.MDL,
      created_by: ana,
    } as never);
    await em.flush();
    householdId = household.id;
    otherHouseholdId = other.id;
    userId = ana.id;
  });

  beforeEach(async () => {
    await orm.em
      .fork()
      .getConnection()
      .execute('DELETE FROM bill_duplicate_dismissals');
    await orm.em
      .fork()
      .getConnection()
      .execute('DELETE FROM bills WHERE household_id IN (?, ?)', [
        householdId,
        otherHouseholdId,
      ]);
  });

  afterAll(async () => {
    await orm.close();
  });

  it('lists each matching pair once, ranked, newest first', async () => {
    const weakOld = [
      await bill({ amount: 10, bill_date: '2026-01-05' }),
      await bill({ amount: 10, bill_date: '2026-01-05' }),
    ];
    const weakNew = [
      await bill({ amount: 20, bill_date: '2026-02-05' }),
      await bill({ amount: 20, bill_date: '2026-02-05' }),
    ];
    const strong = [
      await bill({
        amount: 30,
        bill_date: '2026-01-01',
        market_name_raw: 'Lidl',
      }),
      await bill({
        amount: 30,
        bill_date: '2026-01-01',
        market_name_raw: 'lidl ',
      }),
    ];
    const fiscal = [
      await bill({
        amount: 40,
        bill_date: '2025-05-01',
        fiscal_register_id: 'R1',
        fiscal_receipt_number: '7',
      }),
      await bill({
        amount: 41,
        bill_date: '2025-05-01',
        fiscal_register_id: ' r1',
        fiscal_receipt_number: '7 ',
      }),
    ];
    // Not pairs: different amount, different date, a duplicate, a draft.
    await bill({ amount: 50 });
    await bill({ amount: 51 });
    await bill({ amount: 60, bill_date: '2026-03-01' });
    await bill({ amount: 60, bill_date: '2026-03-02' });
    await bill({ amount: 70, status: BillStatus.DRAFT });
    await bill({ amount: 70, status: BillStatus.DRAFT });
    await bill({ amount: 80, deleted_at: new Date() });
    await bill({ amount: 80 });
    await bill({ amount: 90 }, otherHouseholdId);
    await bill({ amount: 90 });

    const res = await suggest();

    expect(idsOf(res)).toEqual([
      sorted(...(fiscal as [string, string])),
      sorted(...(strong as [string, string])),
      sorted(...(weakNew as [string, string])),
      sorted(...(weakOld as [string, string])),
    ]);
    expect(res.pairs.map((p) => p.match)).toEqual([
      'fiscal',
      'strong',
      'weak',
      'weak',
    ]);
    const first = res.pairs[0];
    expect(first.bill).toMatchObject({
      bill_date: '2025-05-01',
      currency: Currency.MDL,
      created_by_name: 'Ana',
    });
    expect(first.bill).not.toHaveProperty('match');
    expect(first.other).not.toHaveProperty('match');
  });

  it('does not pair a bill with a duplicate of itself', async () => {
    const a = await bill({ amount: 33 });
    const b = await bill({
      amount: 33,
      status: BillStatus.DUPLICATE,
      duplicate_of: a,
    });
    expect(b).toBeDefined();
    expect((await suggest()).pairs).toEqual([]);
  });

  it('respects date_from/date_to', async () => {
    await bill({ amount: 11, bill_date: '2026-01-10' });
    await bill({ amount: 11, bill_date: '2026-01-10' });
    const late = [
      await bill({ amount: 12, bill_date: '2026-06-10' }),
      await bill({ amount: 12, bill_date: '2026-06-10' }),
    ];

    expect(idsOf(await suggest({ date_from: '2026-06-10' }))).toEqual([
      sorted(...(late as [string, string])),
    ]);
    expect((await suggest({ date_to: '2026-01-09' })).pairs).toEqual([]);
    expect(
      (await suggest({ date_from: '2026-01-10', date_to: '2026-06-10' })).pairs,
    ).toHaveLength(2);
  });

  it('rejects date_from later than date_to with 400', async () => {
    await expect(
      suggest({ date_from: '2026-02-01', date_to: '2026-01-01' }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'date_from must not be later than date_to',
    });
  });

  it('hides a dismissed pair whichever bill it was dismissed from', async () => {
    const a = await bill({ amount: 21 });
    const b = await bill({ amount: 21 });
    const c = await bill({ amount: 22 });
    const d = await bill({ amount: 22 });

    await dismiss(a, b);
    await dismiss(d, c);

    expect((await suggest()).pairs).toEqual([]);
  });

  it('keeps other pairs of a dismissed bill', async () => {
    const a = await bill({ amount: 23 });
    const b = await bill({ amount: 23 });
    const c = await bill({ amount: 23 });
    await dismiss(a, b);

    const res = await suggest();
    expect(res.pairs).toHaveLength(2);
    expect(idsOf(res)).not.toContainEqual(sorted(a, b));
    expect(idsOf(res)).toContainEqual(sorted(a, c));
  });

  it('dismissing twice is a no-op', async () => {
    const a = await bill({ amount: 24 });
    const b = await bill({ amount: 24 });

    await dismiss(a, b);
    await dismiss(b, a);

    const rows = (await orm.em
      .fork()
      .getConnection()
      .execute('SELECT * FROM bill_duplicate_dismissals')) as unknown[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      household_id: householdId,
      bill_id: sorted(a, b)[0],
      other_bill_id: sorted(a, b)[1],
      dismissed_by_user_id: userId,
    });
  });

  it('can dismiss from a draft view', async () => {
    const a = await bill({ amount: 25, status: BillStatus.DRAFT });
    const b = await bill({ amount: 25 });
    await expect(dismiss(a, b)).resolves.toBeUndefined();
  });

  it('dismiss refuses self (400) and unknown or other-household bills (404)', async () => {
    const a = await bill({ amount: 26 });
    const gone = await bill({ amount: 26, deleted_at: new Date() });
    const foreign = await bill({ amount: 26 }, otherHouseholdId);

    await expect(dismiss(a, a)).rejects.toMatchObject({ status: 400 });
    await expect(dismiss(a, randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await expect(dismiss(randomUUID(), a)).rejects.toMatchObject({
      status: 404,
    });
    await expect(dismiss(a, gone)).rejects.toMatchObject({ status: 404 });
    await expect(dismiss(a, foreign)).rejects.toMatchObject({ status: 404 });
    await expect(dismiss(foreign, a)).rejects.toMatchObject({ status: 404 });
  });

  it('matches a fiscal pair on different dates', async () => {
    const a = await bill({
      amount: 12,
      bill_date: '2026-01-01',
      fiscal_register_id: 'R2',
      fiscal_receipt_number: '9',
    });
    const b = await bill({
      amount: 13,
      bill_date: '2026-03-01',
      fiscal_register_id: ' r2',
      fiscal_receipt_number: '9 ',
    });
    // Same date range filter applies to both sides.
    const res = await suggest();
    expect(idsOf(res)).toEqual([sorted(a, b)]);
    expect(res.pairs[0].match).toBe('fiscal');
    expect((await suggest({ date_to: '2026-02-01' })).pairs).toEqual([]);
  });

  it('lists a pair matching on both fiscal ids and amount once', async () => {
    const fiscal = { fiscal_register_id: 'R3', fiscal_receipt_number: '1' };
    const a = await bill({ amount: 14, ...fiscal });
    const b = await bill({ amount: 14, ...fiscal });
    expect(idsOf(await suggest())).toEqual([sorted(a, b)]);
  });

  it('orders ties by ids', async () => {
    const created = [
      await bill({ amount: 15 }),
      await bill({ amount: 15 }),
      await bill({ amount: 15 }),
    ];
    const [x, y, z] = [...created].sort();
    // Same match, same date: the order falls to bill id, then other id.
    expect(idsOf(await suggest())).toEqual([
      [x, y],
      [x, z],
      [y, z],
    ]);
  });

  it('finds the right pairs among hundreds of bills', async () => {
    const conn = orm.em.fork().getConnection();
    // 300 bills, each with its own amount, plus a twin for every tenth one.
    await conn.execute(
      `INSERT INTO bills (household_id, created_by_user_id, status, currency, bill_date, amount)
       SELECT ?, ?, 'confirmed', 'MDL', '2026-10-03',
              1000 + g
         FROM generate_series(1, 300) g`,
      [householdId, userId],
    );
    await conn.execute(
      `INSERT INTO bills (household_id, created_by_user_id, status, currency, bill_date, amount)
       SELECT household_id, created_by_user_id, status, currency, bill_date, amount
         FROM bills WHERE household_id = ? AND amount % 10 = 0`,
      [householdId],
    );

    const res = await suggest();

    // Amounts 1010, 1020, ..., 1300: 30 twins.
    expect(res.pairs).toHaveLength(30);
    expect(new Set(res.pairs.map((p) => p.bill.total_amount)).size).toBe(30);
    for (const p of res.pairs) {
      expect(p.bill.total_amount).toBe(p.other.total_amount);
      expect(p.bill.id < p.other.id).toBe(true);
    }
  });

  it('caps at 100 pairs', async () => {
    // 15 identical bills make 105 pairs.
    for (let i = 0; i < 15; i++) await bill({ amount: 27 });

    expect((await suggest()).pairs).toHaveLength(100);
  });
});

describe('totals and the bill list with a duplicate (PostgreSQL)', () => {
  let orm: MikroORM;
  let householdId: string;
  let marketId: string;
  let originalId: string;
  let duplicateId: string;

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
      new MarketService(fork.getRepository(Market), fork),
    );
    return {
      crud,
      duplicates,
      dashboard: new BillDashboardService(fork, rates),
      breakdown: new SpendingBreakdownService(fork, rates),
      markets: new MarketService(fork.getRepository(Market), fork),
    };
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
      email: 'bill-duplicates-totals@example.com',
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Dups totals',
      currency: Currency.EUR,
      created_by: ana,
    } as never);
    const market = em.create(Market, {
      name: 'Linella',
      city: 'Chisinau',
      household,
    } as never);
    const food = em.create(Category, { name: 'Food', household } as never);
    const bread = em.create(SubCategory, {
      name: 'bread',
      category: food,
    } as never);
    const milk = em.create(SubCategory, {
      name: 'milk',
      category: food,
    } as never);

    // The same receipt saved twice.
    const copy = () => {
      const b = em.create(Bill, {
        household,
        created_by: ana,
        market,
        status: BillStatus.CONFIRMED,
        currency: Currency.EUR,
        bill_date: '2026-09-10',
        amount: 30,
      } as never);
      for (const [s, amount] of [
        [bread, 20],
        [milk, 10],
      ] as const) {
        em.create(BillSubCategory, {
          bill: b,
          sub_category: s,
          raw_name: 'item',
          product_count: 1,
          amount,
        } as never);
      }
      return b;
    };
    const a = copy();
    const b = copy();
    await em.flush();
    householdId = household.id;
    marketId = market.id;
    originalId = a.id;
    duplicateId = b.id;
    await services().duplicates.markDuplicate(b.id, householdId, a.id);
  });

  afterAll(async () => {
    await orm.close();
  });

  const sum = (rows: Array<{ total: number }>) =>
    rows.reduce((s, r) => s + r.total, 0);

  it('the dashboard counts the receipt once, per currency and in the household currency', async () => {
    const res = await services().dashboard.getDashboard(householdId, {
      type: 'month',
      year: 2026,
      month: 9,
    });
    const eur = res.by_currency.find((s) => s.currency === Currency.EUR)!;
    expect(sum(eur.period_totals)).toBe(30);
    expect(
      sum(eur.category_stats.map((c) => ({ total: c.total_amount }))),
    ).toBe(30);
    expect(sum(res.in_household_currency.period_totals)).toBe(30);
    expect(
      sum(
        res.in_household_currency.category_stats.map((c) => ({
          total: c.total_amount,
        })),
      ),
    ).toBe(30);
    expect(res.bills.map((x) => x.id)).toEqual([originalId]);
  });

  it('the spending breakdown counts the receipt once', async () => {
    const res = await services().breakdown.getSpendingBreakdown(householdId, {
      period: 'month',
      anchor: '2026-09-15',
    } as never);
    const eur = res.by_currency.find((s) => s.currency === Currency.EUR)!;
    expect(eur.total).toBe(30);
    expect(eur.lines).toBe(2);
    expect(res.in_household_currency.total).toBe(30);
  });

  it('the market bill count counts the receipt once', async () => {
    // MarketService.listMarkets passes an array to `ANY(?)`, which the driver
    // expands into a value list and Postgres rejects (the same known bug as the
    // skipped market_names test in bill-queries.int-spec.ts). Hand the SQL its
    // array as a Postgres array literal so the status filter is what is tested
    // (only uuid arrays are expected, so joining by comma is safe).
    const fork = orm.em.fork();
    const conn = fork.getConnection();
    const execute = conn.execute.bind(conn);
    const spy = jest.spyOn(conn, 'execute').mockImplementation(((
      sql: string,
      params: unknown[] = [],
      ...rest: unknown[]
    ) =>
      (execute as (...a: unknown[]) => unknown)(
        sql,
        params.map((p) => (Array.isArray(p) ? `{${p.join(',')}}` : p)),
        ...rest,
      )) as never);
    const markets = new MarketService(fork.getRepository(Market), fork);

    try {
      const list = await markets.listMarkets(householdId);

      expect(list.find((m) => m.id === marketId)!.bill_count).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('GET /bills hides the duplicate by default', async () => {
    const res = await services().crud.listBills(householdId, {});
    expect(res.data.map((r) => r.id)).toEqual([originalId]);
    expect(res.meta.total).toBe(1);
    expect(res.data[0]).toMatchObject({
      status: BillStatus.CONFIRMED,
      duplicate_of_id: null,
    });
  });

  it('include_duplicates returns both, flagged', async () => {
    const res = await services().crud.listBills(householdId, {
      include_duplicates: true,
    });
    expect(res.meta.total).toBe(2);
    const byId = new Map(res.data.map((r) => [r.id, r]));
    expect(byId.get(duplicateId)).toMatchObject({
      status: BillStatus.DUPLICATE,
      duplicate_of_id: originalId,
    });
    expect(byId.get(originalId)).toMatchObject({
      status: BillStatus.CONFIRMED,
      duplicate_of_id: null,
    });
  });
});
