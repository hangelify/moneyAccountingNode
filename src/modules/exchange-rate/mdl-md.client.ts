import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  EXCHANGE_RATE_CONFIG,
  type ExchangeRateConfig,
} from './exchange-rate.env';
import type {
  ExchangeRateProvider,
  FetchedDay,
  FetchedRate,
} from './exchange-rate.provider';

const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * Official BNM rates through the free mdl.md API (https://mdl.md/en/api,
 * 300 requests/hour per IP, credit "MDL.md"). Its `rate` is already MDL per
 * one unit, whatever `nominal` says: HUF comes back as 0.0549 with nominal 100.
 * A day with no data answers 200 with an empty `rates` array.
 */
@Injectable()
export class MdlMdClient implements ExchangeRateProvider {
  readonly source = 'BNM';
  private readonly log = new Logger(MdlMdClient.name);

  constructor(
    @Inject(EXCHANGE_RATE_CONFIG) private readonly config: ExchangeRateConfig,
  ) {}

  async fetchDay(date: string): Promise<FetchedDay | null> {
    const url = `${this.config.apiUrl}/rates/${encodeURIComponent(date)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw this.unavailable(`request for ${date} failed`, err);
    }

    if (res.status === 404) return null;
    if (!res.ok) {
      throw this.unavailable(`answered HTTP ${res.status} for ${date}`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw this.unavailable(`sent a body that is not JSON for ${date}`, err);
    }

    const rates = parseDay(body, date);
    if (!rates) throw this.unavailable(`sent a malformed body for ${date}`);
    return rates.length > 0 ? { date, rates } : null;
  }

  private unavailable(
    what: string,
    cause?: unknown,
  ): ServiceUnavailableException {
    const reason = cause instanceof Error ? `: ${cause.message}` : '';
    this.log.warn(`mdl.md ${what}${reason}`);
    return new ServiceUnavailableException(
      'Exchange rates are unavailable right now',
    );
  }
}

/** The day's rates, or null when the body is not what the API documents. */
function parseDay(body: unknown, date: string): FetchedRate[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { success, date: echoed, rates } = body as Record<string, unknown>;
  if (success !== true || echoed !== date || !Array.isArray(rates)) {
    return null;
  }

  const parsed: FetchedRate[] = [];
  for (const item of rates as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { currency, rate, nominal } = item as Record<string, unknown>;
    if (
      typeof currency !== 'string' ||
      !CURRENCY_CODE.test(currency) ||
      typeof rate !== 'number' ||
      !Number.isFinite(rate) ||
      rate <= 0 ||
      typeof nominal !== 'number' ||
      !Number.isInteger(nominal) ||
      nominal < 1
    ) {
      return null;
    }
    parsed.push({ currency, rate, nominal });
  }
  return parsed;
}
