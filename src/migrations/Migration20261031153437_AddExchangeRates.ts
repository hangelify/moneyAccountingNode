import { Migration } from '@mikro-orm/migrations';

export class Migration20261031153437_AddExchangeRates extends Migration {
  override up(): void {
    // Official rates cached per day: one row per (source, day, currency).
    this.addSql(`
      create table "exchange_rates" (
        "id" uuid not null default gen_random_uuid(),
        "source" text not null,
        "rate_date" date not null,
        "currency" "currency_enum" not null,
        "base_currency" "currency_enum" not null,
        "rate" numeric(19,6) not null,
        "nominal" int not null,
        "fetched_at" timestamptz not null default now(),
        primary key ("id")
      );
    `);
    this.addSql(`
      alter table "exchange_rates"
        add constraint "exchange_rates_source_date_currency_unique"
        unique ("source", "rate_date", "currency");
    `);
    // A row here means the day was fetched, so a currency missing from
    // exchange_rates for it is not quoted by the source.
    this.addSql(`
      create table "exchange_rate_days" (
        "source" text not null,
        "rate_date" date not null,
        "currency_count" int not null,
        "fetched_at" timestamptz not null default now(),
        primary key ("source", "rate_date")
      );
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists "exchange_rate_days";`);
    this.addSql(`drop table if exists "exchange_rates";`);
  }
}
