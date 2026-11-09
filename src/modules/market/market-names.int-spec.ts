import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Market } from '../../entities/market.entity';
import { MarketService } from './market.service';

jest.setTimeout(30_000);

// Market names against the real schema: findOrCreate matches the name
// exactly, ignoring case, and the unique index keeps a household to one live
// market per name.
describe('market names (PostgreSQL)', () => {
  let orm: MikroORM;
  let userId: string;
  let householdId: string;
  let otherHouseholdId: string;

  const sql = (query: string, params: unknown[] = []) =>
    orm.em.getConnection().execute(query, params);

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
    userId = randomUUID();
    householdId = randomUUID();
    otherHouseholdId = randomUUID();
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Market', ?, 'x')`,
      [userId, `market-${userId}@example.com`],
    );
    for (const id of [householdId, otherHouseholdId]) {
      await sql(
        `insert into households (id, name, created_by, currency) values (?, 'Market', ?, 'EUR')`,
        [id, userId],
      );
    }
  });

  beforeEach(async () => {
    await sql('delete from markets where household_id in (?, ?)', [
      householdId,
      otherHouseholdId,
    ]);
  });

  afterAll(async () => {
    if (!orm) return;
    await sql('delete from markets where household_id in (?, ?)', [
      householdId,
      otherHouseholdId,
    ]);
    await sql('delete from households where id in (?, ?)', [
      householdId,
      otherHouseholdId,
    ]);
    await sql('delete from users where id = ?', [userId]);
    await orm.close(true);
  });

  const insertMarket = async (
    name: string,
    hid = householdId,
    deleted = false,
  ): Promise<string> => {
    const id = randomUUID();
    await sql(
      `insert into markets (id, name, household_id, deleted_at) values (?, ?, ?, ${deleted ? 'now()' : 'null'})`,
      [id, name, hid],
    );
    return id;
  };

  const findOrCreate = (name: string, extra: Partial<Market> = {}) => {
    const fork = orm.em.fork();
    const service = new MarketService(fork.getRepository(Market), fork);
    return fork.transactional((em) =>
      service.findOrCreate(em, householdId, { name, ...extra }),
    );
  };

  const marketsNamed = async (name: string) =>
    (await sql(
      'select id from markets where household_id = ? and lower(name) = lower(?) and deleted_at is null',
      [householdId, name],
    )) as Array<{ id: string }>;

  it('finds the market of the same name, ignoring case', async () => {
    const id = await insertMarket('Lidl');

    const market = await findOrCreate('LIDL');

    expect(market.id).toBe(id);
  });

  it('treats LIKE wildcards in the name as plain characters', async () => {
    const lidl = await insertMarket('Lidl');

    const percent = await findOrCreate('%');
    const underscore = await findOrCreate('L_dl');

    expect(percent.id).not.toBe(lidl);
    expect(percent.name).toBe('%');
    expect(underscore.id).not.toBe(lidl);
  });

  it('creates a market with the given details when none matches', async () => {
    const market = await findOrCreate('Kaufland', {
      city: 'Chisinau',
      country: 'MD',
      address: 'Str. 1',
    });

    const fork = orm.em.fork();
    const saved = await fork.findOneOrFail(Market, market.id, {
      populate: ['household'],
    });
    expect(saved).toMatchObject({
      name: 'Kaufland',
      city: 'Chisinau',
      country: 'MD',
      address: 'Str. 1',
    });
    expect(saved.household.id).toBe(householdId);
  });

  it('ignores deleted markets and markets of other households', async () => {
    const deleted = await insertMarket('Linella', householdId, true);
    const foreign = await insertMarket('Linella', otherHouseholdId);

    const market = await findOrCreate('Linella');

    expect([deleted, foreign]).not.toContain(market.id);
  });

  it('gives concurrent calls one market', async () => {
    // A creates the market and holds its transaction open while B, which
    // cannot see A's row yet, finds or creates the same name.
    let created!: () => void;
    let release!: () => void;
    const aCreated = new Promise<void>((r) => (created = r));
    const aReleased = new Promise<void>((r) => (release = r));
    const fork = orm.em.fork();
    const service = new MarketService(fork.getRepository(Market), fork);
    const a = fork.transactional(async (em) => {
      const market = await service.findOrCreate(em, householdId, {
        name: 'Metro',
      });
      created();
      await aReleased;
      return market;
    });
    await aCreated;
    const b = findOrCreate('METRO');
    await new Promise((r) => setTimeout(r, 200));
    release();

    const [ma, mb] = await Promise.all([a, b]);

    expect(mb.id).toBe(ma.id);
    expect(await marketsNamed('metro')).toHaveLength(1);
  });

  const service = () => {
    const fork = orm.em.fork();
    return new MarketService(fork.getRepository(Market), fork);
  };

  it('rejects creating a market under a live name with 409', async () => {
    await insertMarket('Lidl');

    await expect(
      service().createMarket(householdId, { name: 'lidl' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a market under the name of a deleted one', async () => {
    await insertMarket('Lidl', householdId, true);

    const market = await service().createMarket(householdId, { name: 'Lidl' });

    expect(market.name).toBe('Lidl');
  });

  it('rejects renaming a market to a live name with 409', async () => {
    await insertMarket('Lidl');
    const id = await insertMarket('Metro');

    await expect(
      service().updateMarket(id, householdId, { name: 'LIDL' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('renames a market to another case of its own name', async () => {
    const id = await insertMarket('lidl');

    const market = await service().updateMarket(id, householdId, {
      name: 'Lidl',
    });

    expect(market.name).toBe('Lidl');
  });
});
