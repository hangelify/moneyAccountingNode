import { Migration } from '@mikro-orm/migrations';

// Marks "do not carry this period's limit balance over to the next period"
// (HAN-25), one per category and period. A new table, so no existing rows are
// touched. Rows follow their household and category (cascade); a deleted
// user only clears created_by.
export class Migration20261117100000_AddCategoryLimitCarryStops extends Migration {
  override up(): void {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`set local statement_timeout = '60s';`);
    this.addSql(
      `create table "category_limit_carry_stops" ("id" uuid not null default gen_random_uuid(), "household_id" uuid not null, "category_id" uuid not null, "period_type" "limit_period_type" not null, "period_start" date not null, "created_by_id" uuid null, "created_at" timestamptz not null default now(), primary key ("id"));`,
    );
    this.addSql(
      `create index "category_limit_carry_stops_created_by_id_index" on "category_limit_carry_stops" ("created_by_id");`,
    );
    this.addSql(
      `create index "category_limit_carry_stops_household_index" on "category_limit_carry_stops" ("household_id", "period_type", "category_id", "period_start");`,
    );
    this.addSql(
      `alter table "category_limit_carry_stops" add constraint "category_limit_carry_stops_unique" unique ("category_id", "period_type", "period_start");`,
    );
    this.addSql(
      `alter table "category_limit_carry_stops" add constraint "category_limit_carry_stops_household_id_fkey" foreign key ("household_id") references "households" ("id") on update cascade on delete cascade;`,
    );
    this.addSql(
      `alter table "category_limit_carry_stops" add constraint "category_limit_carry_stops_category_id_fkey" foreign key ("category_id") references "categories" ("id") on update cascade on delete cascade;`,
    );
    this.addSql(
      `alter table "category_limit_carry_stops" add constraint "category_limit_carry_stops_created_by_id_fkey" foreign key ("created_by_id") references "users" ("id") on update cascade on delete set null;`,
    );
  }

  override down(): void {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`set local statement_timeout = '60s';`);
    this.addSql(`drop table if exists "category_limit_carry_stops";`);
  }
}
