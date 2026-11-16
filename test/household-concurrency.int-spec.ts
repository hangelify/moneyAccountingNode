import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../src/mikro-orm.config';
import { HouseholdMember } from '../src/entities/household-member.entity';
import { HouseholdService } from '../src/modules/household/household.service';
import { CategoryDefaultsService } from '../src/modules/category/category-defaults.service';

jest.setTimeout(30_000);

// HAN-22: the household limit and the last-household rule hold under
// concurrent requests of one user.
describe('household concurrency (PostgreSQL)', () => {
  let orm: MikroORM;
  let service: HouseholdService;

  const sql = <T = unknown>(
    query: string,
    params: unknown[] = [],
  ): Promise<T> => orm.em.getConnection().execute(query, params) as Promise<T>;

  async function user(): Promise<string> {
    const id = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password, currency) values (?, 'Conc', ?, 'x', 'EUR')`,
      [id, `conc-${id}@example.com`],
    );
    return id;
  }

  async function liveHouseholds(userId: string): Promise<number> {
    const rows = await sql<{ n: number }[]>(
      `select count(*)::int as n from household_members m
         join households h on h.id = m.household_id
        where m.user_id = ? and h.deleted_at is null`,
      [userId],
    );
    return rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    process.env['FRONTEND_URL'] ??= 'https://app.example.com';
    orm = await MikroORM.init(createMikroOrmConfig());
    service = new HouseholdService(
      orm.em.getRepository(HouseholdMember),
      orm.em,
      { maxActiveInvites: 20, maxHouseholds: 5 },
      new CategoryDefaultsService(orm.em),
    );
  });

  afterAll(async () => {
    await orm.close(true);
  });

  it('does not overshoot the limit under concurrent creates', async () => {
    const uid = await user();
    for (let i = 0; i < 4; i++) {
      await service.createHousehold(uid, { name: `H${String(i)}` });
    }

    const results = await Promise.allSettled([
      service.createHousehold(uid, { name: 'A' }),
      service.createHousehold(uid, { name: 'B' }),
      service.createHousehold(uid, { name: 'C' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect(r.reason).toBeInstanceOf(ConflictException);
    }
    expect(await liveHouseholds(uid)).toBe(5);
  });
});
