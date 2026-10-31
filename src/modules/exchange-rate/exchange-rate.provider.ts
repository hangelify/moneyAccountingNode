export const EXCHANGE_RATE_PROVIDER = Symbol('EXCHANGE_RATE_PROVIDER');

export interface FetchedRate {
  /** ISO 4217 code as the source spells it; may be outside `Currency`. */
  currency: string;
  /** MDL for one unit of `currency`. */
  rate: number;
  /** Units BNM quotes the currency in (1, 10, 100); informational only. */
  nominal: number;
}

export interface FetchedDay {
  date: string;
  rates: FetchedRate[];
}

/** One source of official MDL rates (BNM via mdl.md today). */
export interface ExchangeRateProvider {
  readonly source: string;
  /**
   * The rates for `date` (`YYYY-MM-DD`), or null when the source has none for
   * that day yet. Throws ServiceUnavailableException when it cannot be asked.
   */
  fetchDay(date: string): Promise<FetchedDay | null>;
}
