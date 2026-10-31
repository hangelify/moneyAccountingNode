import { Entity, Property, Enum, Unique } from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Currency } from '../types/currency.enum';

/** One official rate: MDL for one unit of `currency` on `rate_date`. */
@Entity({ tableName: 'exchange_rates' })
@Unique({
  name: 'exchange_rates_source_date_currency_unique',
  properties: ['source', 'rate_date', 'currency'],
})
export class ExchangeRate extends BaseEntity {
  /** Who published the rate, e.g. `BNM`. */
  @Property({ type: 'text', nullable: false })
  source!: string;

  /** `YYYY-MM-DD`; the `date` column has no time or timezone. */
  @Property({ type: 'date', runtimeType: 'string', nullable: false })
  rate_date!: string;

  @Enum({
    items: () => Currency,
    type: 'enum',
    nativeEnumName: 'currency_enum',
    nullable: false,
  })
  currency!: Currency;

  @Enum({
    items: () => Currency,
    type: 'enum',
    nativeEnumName: 'currency_enum',
    nullable: false,
  })
  base_currency!: Currency;

  /** `base_currency` per one unit of `currency`; decimal comes back as a string. */
  @Property({ type: 'decimal', precision: 19, scale: 6, nullable: false })
  rate!: string;

  /** Units the source quotes the currency in (1, 10, 100); informational. */
  @Property({ type: 'integer', nullable: false })
  nominal!: number;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  fetched_at!: Date;
}
