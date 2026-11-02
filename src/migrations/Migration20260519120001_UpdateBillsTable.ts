import { Migration } from '@mikro-orm/migrations';

export class Migration20260519120001_UpdateBillsTable extends Migration {
  override up(): void {
    this.addSql(`alter table "bills" drop column if exists "marked_name";`);
    this.addSql(`alter table "bills" drop column if exists "product_count";`);
    this.addSql(`alter table "bills" add column "user_id" uuid not null;`);
    this.addSql(`alter table "bills" add column "market_id" uuid null;`);
    this.addSql(
      `alter table "bills" add column "currency" "currency_enum" null;`,
    );
    this.addSql(`
      alter table "bills"
        add constraint "bills_user_id_fkey"
          foreign key ("user_id") references "users" ("id") on delete cascade,
        add constraint "bills_market_id_fkey"
          foreign key ("market_id") references "markets" ("id") on delete set null;
    `);
    this.addSql(`create index "bills_user_id_index" on "bills" ("user_id");`);
  }

  override down(): void {
    this.addSql(
      `alter table "bills" drop constraint if exists "bills_user_id_fkey";`,
    );
    this.addSql(
      `alter table "bills" drop constraint if exists "bills_market_id_fkey";`,
    );
    this.addSql(`drop index if exists "bills_user_id_index";`);
    this.addSql(`alter table "bills" drop column if exists "user_id";`);
    this.addSql(`alter table "bills" drop column if exists "market_id";`);
    this.addSql(`alter table "bills" drop column if exists "currency";`);
    this.addSql(
      `alter table "bills" add column "marked_name" varchar(255) null;`,
    );
    this.addSql(
      `alter table "bills" add column "product_count" integer not null default 1;`,
    );
  }
}
