import type {
  ExchangeRateProvider,
  FetchedDay,
} from '../exchange-rate.provider';

/** A provider whose answer per day is set by the test; counts its calls. */
export class StubProvider implements ExchangeRateProvider {
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

  /** Specs sharing one database use their own source so rows never mix. */
  constructor(readonly source = 'TEST') {}

  fetchDay(date: string): Promise<FetchedDay | null> {
    this.calls.push(date);
    return this.answer(date);
  }
}
