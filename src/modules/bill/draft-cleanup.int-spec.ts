import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { Bill } from '../../entities/bill.entity';
import { Household } from '../../entities/household.entity';
import { User } from '../../entities/user.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { DraftCleanupService } from './draft-cleanup.service';

jest.setTimeout(30_000);

describe('DraftCleanupService (PostgreSQL)', () => {
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
      first_name: 'Cleanup',
      email: `p14-cleanup-${randomUUID()}@example.com`,
      password: 'x',
    } as never);
    const household = em.create(Household, {
      name: 'P14 cleanup',
      created_by: user,
    } as never);
    await em.flush();
    userId = user.id;
    householdId = household.id;
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = orm.em.getConnection();
    await conn.execute('DELETE FROM bills WHERE household_id = ?', [
      householdId,
    ]);
    await conn.execute('DELETE FROM households WHERE id = ?', [householdId]);
    await conn.execute('DELETE FROM users WHERE id = ?', [userId]);
    await orm.close(true);
  });

  const now = new Date('2026-10-11T12:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  async function bill(status: BillStatus, createdAt: Date): Promise<string> {
    const em = orm.em.fork();
    const b = em.create(Bill, {
      household: em.getReference(Household, householdId),
      status,
      amount: 1,
      bill_date: createdAt,
    } as never);
    await em.flush();
    await orm.em
      .getConnection()
      .execute('UPDATE bills SET created_at = ? WHERE id = ?', [
        createdAt,
        b.id,
      ]);
    return b.id;
  }

  /** deleted_at as epoch milliseconds, or null. */
  async function deletedAt(id: string): Promise<number | null> {
    const [row] = (await orm.em
      .getConnection()
      .execute(
        'SELECT extract(epoch from deleted_at) * 1000 AS ms FROM bills WHERE id = ?',
        [id],
      )) as { ms: string | null }[];
    return row.ms === null ? null : Number(row.ms);
  }

  it('soft-deletes only drafts older than the retention period', async () => {
    const stale = await bill(BillStatus.DRAFT, daysAgo(31));
    const fresh = await bill(BillStatus.DRAFT, daysAgo(29));
    const oldConfirmed = await bill(BillStatus.CONFIRMED, daysAgo(400));

    const purged = await new DraftCleanupService(orm.em, 30).purgeStaleDrafts(
      now,
    );

    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await deletedAt(stale)).not.toBeNull();
    expect(await deletedAt(fresh)).toBeNull();
    expect(await deletedAt(oldConfirmed)).toBeNull();
  });

  it('keeps the deletion time of a draft deleted earlier', async () => {
    const id = await bill(BillStatus.DRAFT, daysAgo(60));
    const earlier = new Date('2026-09-01T00:00:00Z');
    await orm.em
      .getConnection()
      .execute('UPDATE bills SET deleted_at = ? WHERE id = ?', [earlier, id]);

    await new DraftCleanupService(orm.em, 30).purgeStaleDrafts(now);

    expect(await deletedAt(id)).toBe(earlier.getTime());
  });
});
