import { Migration } from '@mikro-orm/migrations';

export class Migration20260519120000_CreateMarketsTable extends Migration {
  override up(): void {
    this.addSql(`
      create table "markets" (
        "id" uuid not null default gen_random_uuid(),
        "name" varchar(255) not null,
        "address" varchar(500) null,
        "city" varchar(255) not null,
        "country" varchar(2) not null,
        "user_id" uuid not null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "markets_pkey" primary key ("id"),
        constraint "markets_user_id_fkey"
          foreign key ("user_id") references "users" ("id") on delete cascade
      );
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists "markets";`);
  }
}
