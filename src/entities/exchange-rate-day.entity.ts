import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * A day whose rates were fetched from `source`. Lets a lookup for a currency
 * the source does not quote answer 404 without asking the API again.
 */
@Entity({ tableName: 'exchange_rate_days' })
export class ExchangeRateDay {
  @PrimaryKey({ type: 'text' })
  source!: string;

  /** `YYYY-MM-DD`; the `date` column has no time or timezone. */
  @PrimaryKey({ type: 'date', runtimeType: 'string' })
  rate_date!: string;

  /** Rows saved into `exchange_rates` for that day. */
  @Property({ type: 'integer', nullable: false })
  currency_count!: number;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  fetched_at!: Date;
}
