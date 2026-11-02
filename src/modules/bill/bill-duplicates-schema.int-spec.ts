import { MikroORM, EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { BillDuplicateDismissal } from '../../entities/bill-duplicate-dismissal.entity';
import { Household } from '../../entities/household.entity';
import { User } from '../../entities/user.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { Currency } from '../../types/currency.enum';

// The duplicate-bill schema constraints, run against the real migrations.
describe('duplicate bills schema (PostgreSQL)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let householdId: string;
  let userId: string;
  let billA: string;
  let billB: string;

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
    em = orm.em.fork();

    const user = em.create(User, {
      first_name: 'Dup',
      email: 'bill-duplicates-schema@example.com',
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'Dup',
      currency: Currency.EUR,
      created_by: user,
    } as never);
    const bill = (amount: number) =>
      em.create(Bill, {
        household,
        created_by: user,
        status: BillStatus.CONFIRMED,
        currency: Currency.EUR,
        bill_date: '2026-03-05',
        amount,
      } as never);
    const a = bill(10);
    const b = bill(10);
    await em.flush();
    householdId = household.id;
    userId = user.id;
    [billA, billB] = [a.id, b.id].sort();
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  const exec = (sql: string, params: unknown[] = []) =>
    em.getConnection().execute(sql, params);

  const insertDismissal = (bill: string, other: string) =>
    exec(
      `insert into "bill_duplicate_dismissals" ("household_id", "bill_id", "other_bill_id", "dismissed_by_user_id") values (?, ?, ?, ?)`,
      [householdId, bill, other, userId],
    );

  it('rejects a duplicate without an original', async () => {
    await expect(
      exec(`update "bills" set "status" = 'duplicate' where "id" = ?`, [billA]),
    ).rejects.toThrow(/bills_duplicate_of_check/);
  });

  it('rejects an original on a non-duplicate', async () => {
    await expect(
      exec(`update "bills" set "duplicate_of_id" = ? where "id" = ?`, [
        billB,
        billA,
      ]),
    ).rejects.toThrow(/bills_duplicate_of_check/);
  });

  it('saves a duplicate with its original', async () => {
    await exec(
      `update "bills" set "status" = 'duplicate', "duplicate_of_id" = ? where "id" = ?`,
      [billB, billA],
    );
    const rows = (await exec(
      `select "status", "duplicate_of_id" from "bills" where "id" = ?`,
      [billA],
    )) as Array<{ status: string; duplicate_of_id: string }>;
    expect(rows[0]).toEqual({ status: 'duplicate', duplicate_of_id: billB });
  });

  it('stores a dismissal pair once, smaller id first', async () => {
    await expect(insertDismissal(billB, billA)).rejects.toThrow(
      /bill_duplicate_dismissals_order_check/,
    );
    await insertDismissal(billA, billB);
    await expect(insertDismissal(billA, billB)).rejects.toThrow(
      /bill_duplicate_dismissals_pair_unique/,
    );
    expect(
      await orm.em.fork().count(BillDuplicateDismissal, { bill: billA }),
    ).toBe(1);
  });

  it('round-trips purchase_time as HH:MM', async () => {
    const fork = orm.em.fork();
    const bill = await fork.findOneOrFail(Bill, billB);
    bill.purchase_time = '14:05';
    await fork.flush();

    const read = await orm.em.fork().findOneOrFail(Bill, billB);
    expect(read.purchase_time).toBe('14:05');
  });
});
