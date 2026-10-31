import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { Currency } from '../../types/currency.enum';
import { isCalendarDate } from '../../common/utils/calendar-date';
import {
  EXCHANGE_RATE_PROVIDER,
  type ExchangeRateProvider,
  type FetchedRate,
} from './exchange-rate.provider';

const KNOWN_CURRENCIES = new Set<string>(Object.values(Currency));

/** BNM publishes in Moldovan time; `today` there may differ from UTC. */
function chisinauToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Chisinau',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Official MDL rates per calendar day, read through a local cache: a day is
 * asked from the provider once, all of its currencies are saved, and every
 * later lookup for that day is answered from PostgreSQL.
 */
@Injectable()
export class ExchangeRateService {
  private readonly log = new Logger(ExchangeRateService.name);
  /** Fetches running in this process, by date; parallel lookups share one. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly em: EntityManager,
    @Inject(EXCHANGE_RATE_PROVIDER)
    private readonly provider: ExchangeRateProvider,
  ) {}

  /** MDL for one unit of `currency` on `date` (`YYYY-MM-DD`). */
  async getRate(currency: Currency, date: string): Promise<number> {
    this.assertDate(date);
    if (currency === Currency.MDL) return 1;

    const saved = await this.findRate(currency, date);
    if (saved !== null) return saved;

    await this.ensureDay(date);
    const fetched = await this.findRate(currency, date);
    if (fetched === null) {
      throw new NotFoundException(
        `No ${this.provider.source} rate for ${currency} on ${date}`,
      );
    }
    return fetched;
  }

  /** Every saved rate of `date`, MDL per unit, with MDL itself as 1. */
  async getRatesForDay(
    date: string,
  ): Promise<Partial<Record<Currency, number>>> {
    this.assertDate(date);
    await this.ensureDay(date);
    const rows = (await this.em.getConnection().execute(
      `SELECT currency, rate::text AS rate FROM exchange_rates
         WHERE source = ? AND rate_date = ?`,
      [this.provider.source, date],
    )) as { currency: Currency; rate: string }[];

    const rates: Partial<Record<Currency, number>> = { [Currency.MDL]: 1 };
    for (const r of rows) rates[r.currency] = Number(r.rate);
    return rates;
  }

  /** `amount` of `from` in `to` at the rates of `date`, rounded to cents. */
  async convert(
    amount: number,
    from: Currency,
    to: Currency,
    date: string,
  ): Promise<number> {
    this.assertDate(date);
    if (from === to) return amount;
    const [fromRate, toRate] = await Promise.all([
      this.getRate(from, date),
      this.getRate(to, date),
    ]);
    return Math.round(((amount * fromRate) / toRate) * 100) / 100;
  }

  private assertDate(date: string): void {
    if (!isCalendarDate(date)) {
      throw new BadRequestException('date must be a YYYY-MM-DD calendar day');
    }
    if (date > chisinauToday()) {
      throw new BadRequestException(`No rates exist yet for ${date}`);
    }
  }

  private async findRate(
    currency: Currency,
    date: string,
  ): Promise<number | null> {
    const [row] = (await this.em.getConnection().execute(
      `SELECT rate::text AS rate FROM exchange_rates
         WHERE source = ? AND rate_date = ? AND currency = ?`,
      [this.provider.source, date, currency],
    )) as { rate: string }[];
    return row ? Number(row.rate) : null;
  }

  /** Makes sure `date` was fetched; throws when the provider has nothing. */
  private async ensureDay(date: string): Promise<void> {
    const [marker] = (await this.em
      .getConnection()
      .execute(
        'SELECT 1 FROM exchange_rate_days WHERE source = ? AND rate_date = ?',
        [this.provider.source, date],
      )) as unknown[];
    if (marker) return;

    let pending = this.inFlight.get(date);
    if (!pending) {
      pending = this.fetchAndSave(date).finally(() =>
        this.inFlight.delete(date),
      );
      this.inFlight.set(date, pending);
    }
    await pending;
  }

  private async fetchAndSave(date: string): Promise<void> {
    const day = await this.provider.fetchDay(date);
    // No marker: the day may still be published later.
    if (!day) {
      throw new NotFoundException(
        `No ${this.provider.source} rates published for ${date}`,
      );
    }

    const rates = day.rates.filter((r) => KNOWN_CURRENCIES.has(r.currency));
    const skipped = day.rates.length - rates.length;
    if (skipped > 0) {
      this.log.debug(
        `Skipped ${skipped} currency code(s) outside Currency for ${date}`,
      );
    }

    // Other instances may save the same day at once: rows and marker are
    // written together and a duplicate is ignored, never an error.
    await this.em.fork().transactional(async (tx) => {
      const conn = tx.getConnection();
      if (rates.length > 0) {
        await conn.execute(
          `INSERT INTO exchange_rates
             (source, rate_date, currency, base_currency, rate, nominal)
           VALUES ${rates.map(() => `(?, ?, ?, 'MDL', ?, ?)`).join(', ')}
           ON CONFLICT (source, rate_date, currency) DO NOTHING`,
          rates.flatMap((r: FetchedRate) => [
            this.provider.source,
            date,
            r.currency,
            r.rate,
            r.nominal,
          ]),
          'run',
          tx.getTransactionContext(),
        );
      }
      await conn.execute(
        `INSERT INTO exchange_rate_days (source, rate_date, currency_count)
         VALUES (?, ?, ?)
         ON CONFLICT (source, rate_date) DO NOTHING`,
        [this.provider.source, date, rates.length],
        'run',
        tx.getTransactionContext(),
      );
    });
  }
}
