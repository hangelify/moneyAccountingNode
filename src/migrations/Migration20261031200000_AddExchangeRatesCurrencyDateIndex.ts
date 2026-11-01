import { Migration } from '@mikro-orm/migrations';

export class Migration20261031200000_AddExchangeRatesCurrencyDateIndex extends Migration {
  override up(): void {
    // The bill conversion lookup: latest rate of one currency on or before a
    // day. With currency before rate_date the walk stays within that currency,
    // also for one the source does not quote. Plain CREATE INDEX: see
    // AddHouseholdAndForeignKeyIndexes.
    this.addSql(
      `create index if not exists "exchange_rates_source_currency_date_index" on "exchange_rates" ("source", "currency", "rate_date" desc);`,
    );
  }

  override down(): void {
    this.addSql(
      `drop index if exists "exchange_rates_source_currency_date_index";`,
    );
  }
}
