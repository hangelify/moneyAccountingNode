import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Test } from '@nestjs/testing';
import { Currency } from '../../types/currency.enum';
import type {
  ExchangeRateProvider,
  FetchedDay,
} from './exchange-rate.provider';
import { ExchangeRateService } from './exchange-rate.service';

jest.setTimeout(30_000);

const SOURCE = 'TEST';

/** A provider whose answer per day is set by the test; counts its calls. */
class StubProvider implements ExchangeRateProvider {
  readonly source = SOURCE;
  calls: string[] = [];
  answer: (date: string) => Promise<FetchedDay | null> = (date) =>
    Promise.resolve({
      date,
      rates: [
        { currency: 'EUR', rate: 20.0954, nominal: 1 },
        { currency: 'USD', rate: 18.0365, nominal: 1 },
        { currency: 'HUF', rate: 0.0549, nominal: 100 },
        // Quoted by BNM but not in Currency: skipped.
        { currency: 'AUD', rate: 12.6824, nominal: 1 },
      ],
    });

  fetchDay(date: string): Promise<FetchedDay | null> {
    this.calls.push(date);
    return this.answer(date);
  }
}

describe('ExchangeRateService (PostgreSQL)', () => {
  let orm: MikroORM;
  let provider: StubProvider;
  let service: ExchangeRateService;
  // Every test uses its own day, so they never see each other's rows.
  let day = 0;
  const nextDate = () => `2001-01-${String(++day).padStart(2, '0')}`;

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
  });

  beforeEach(() => {
    provider = new StubProvider();
    service = new ExchangeRateService(orm.em, provider);
  });

  afterAll(async () => {
    if (!orm) return;
    const conn = orm.em.getConnection();
    await conn.execute('DELETE FROM exchange_rates WHERE source = ?', [SOURCE]);
    await conn.execute('DELETE FROM exchange_rate_days WHERE source = ?', [
      SOURCE,
    ]);
    await orm.close(true);
  });

  async function storedCurrencies(date: string): Promise<string[]> {
    const rows = (await orm.em
      .getConnection()
      .execute(
        'SELECT currency FROM exchange_rates WHERE source = ? AND rate_date = ? ORDER BY currency',
        [SOURCE, date],
      )) as { currency: string }[];
    return rows.map((r) => r.currency);
  }

  it('fetches a missing day once and saves every known currency', async () => {
    const date = nextDate();

    await expect(service.getRate(Currency.EUR, date)).resolves.toBe(20.0954);

    expect(provider.calls).toEqual([date]);
    expect(await storedCurrencies(date)).toEqual(['EUR', 'HUF', 'USD']);
  });

  it('answers a saved day from the database', async () => {
    const date = nextDate();
    await service.getRate(Currency.EUR, date);

    await expect(service.getRate(Currency.USD, date)).resolves.toBe(18.0365);
    await expect(service.getRate(Currency.HUF, date)).resolves.toBe(0.0549);

    expect(provider.calls).toHaveLength(1);
  });

  it('answers 404 for a currency the fetched day does not quote, without refetching', async () => {
    const date = nextDate();
    await service.getRate(Currency.EUR, date);

    await expect(service.getRate(Currency.JPY, date)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getRate(Currency.JPY, date)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(provider.calls).toHaveLength(1);
  });

  it('fetches a new day once for many parallel lookups', async () => {
    const date = nextDate();
    // A slow answer keeps every caller past the day check before it lands.
    const answer = provider.answer;
    provider.answer = (d) =>
      new Promise((resolve) => setTimeout(resolve, 50)).then(() => answer(d));

    const rates = await Promise.all(
      Array.from({ length: 10 }, () => service.getRate(Currency.EUR, date)),
    );

    expect(rates).toEqual(Array(10).fill(20.0954));
    expect(provider.calls).toHaveLength(1);
  });

  it('lets two instances save the same day without failing', async () => {
    const date = nextDate();
    const other = new ExchangeRateService(orm.em, provider);
    // Both instances fetch, then both insert the same rows.
    const answer = provider.answer;
    provider.answer = (d) =>
      new Promise((resolve) => setTimeout(resolve, 50)).then(() => answer(d));

    await expect(
      Promise.all([
        service.getRate(Currency.EUR, date),
        other.getRate(Currency.USD, date),
      ]),
    ).resolves.toEqual([20.0954, 18.0365]);
    expect(await storedCurrencies(date)).toEqual(['EUR', 'HUF', 'USD']);
  });

  it('saves nothing when the provider fails, and retries next time', async () => {
    const date = nextDate();
    provider.answer = () =>
      Promise.reject(new ServiceUnavailableException('down'));

    await expect(service.getRate(Currency.EUR, date)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(await storedCurrencies(date)).toEqual([]);

    provider.answer = new StubProvider().answer;
    await expect(service.getRate(Currency.EUR, date)).resolves.toBe(20.0954);
    expect(provider.calls).toHaveLength(2);
  });

  it('answers 404 for a day with no rates yet, and asks again next time', async () => {
    const date = nextDate();
    provider.answer = () => Promise.resolve(null);

    await expect(service.getRate(Currency.EUR, date)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getRate(Currency.EUR, date)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(provider.calls).toHaveLength(2);
  });

  it('returns 1 for MDL without asking anyone', async () => {
    await expect(service.getRate(Currency.MDL, nextDate())).resolves.toBe(1);
    expect(provider.calls).toEqual([]);
  });

  it.each(['2001-02-30', '01.01.2001', '2999-01-01'])(
    'rejects the date %s before any lookup',
    async (date) => {
      await expect(service.getRate(Currency.EUR, date)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(provider.calls).toEqual([]);
    },
  );

  it('returns all rates of a day, MDL included', async () => {
    const date = nextDate();

    await expect(service.getRatesForDay(date)).resolves.toEqual({
      MDL: 1,
      EUR: 20.0954,
      USD: 18.0365,
      HUF: 0.0549,
    });
    await service.getRatesForDay(date);
    expect(provider.calls).toHaveLength(1);
  });

  describe('convert', () => {
    it('converts into MDL', async () => {
      await expect(
        service.convert(100, Currency.EUR, Currency.MDL, nextDate()),
      ).resolves.toBe(2009.54);
    });

    it('converts out of MDL', async () => {
      await expect(
        service.convert(100, Currency.MDL, Currency.USD, nextDate()),
      ).resolves.toBe(5.54);
    });

    it('crosses two foreign currencies through MDL', async () => {
      // 100 × 20.0954 / 18.0365 = 111.415...
      await expect(
        service.convert(100, Currency.EUR, Currency.USD, nextDate()),
      ).resolves.toBe(111.42);
    });

    it('uses the per-unit rate even when the nominal is 100', async () => {
      // 10000 HUF × 0.0549 = 549 MDL
      await expect(
        service.convert(10_000, Currency.HUF, Currency.MDL, nextDate()),
      ).resolves.toBe(549);
    });

    it('keeps the amount for the same currency without asking anyone', async () => {
      await expect(
        service.convert(12.34, Currency.JPY, Currency.JPY, nextDate()),
      ).resolves.toBe(12.34);
      expect(provider.calls).toEqual([]);
    });
  });
});
