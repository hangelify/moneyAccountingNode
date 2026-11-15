import { Migration } from '@mikro-orm/migrations';

/**
 * Stops the migration before anything is dropped when a legacy table still
 * holds rows, soft-deleted ones included. Exported for the migration test.
 */
export const LEGACY_ROWS_GUARD_SQL = `
  do $$
  declare
    n bigint;
  begin
    select (select count(*) from budgets)
         + (select count(*) from planing_horizons)
         + (select count(*) from planing_horizon_categories)
      into n;
    if n > 0 then
      raise exception 'budgets/planing_horizons: % rows found, export them before HAN-24 migration', n;
    end if;
  end $$;
`;

// The legacy schema as the last migrations that touched it left it
// (Migration20251224124554 … Migration20261011150000), without data.
const LEGACY_SCHEMA_SQL = [
  `create type "period_type_enum" as enum ('DAILY', 'WEEKLY', 'TWO_WEEKS', 'THREE_WEEKS', 'MONTHLY', 'TWO_MONTHS', 'QUARTERLY', 'SEMI_ANNUAL', 'YEARLY');`,
  `
    create table "budgets" (
      "id" uuid not null default gen_random_uuid(),
      "name" varchar(255) not null,
      "description" text,
      "created_at" timestamptz not null default now(),
      "deleted_at" timestamptz,
      "household_id" uuid not null,
      constraint "budgets_pkey" primary key ("id")
    );
  `,
  `
    alter table "budgets" add constraint "budgets_household_id_fkey"
      foreign key ("household_id") references "households" ("id") on delete cascade;
  `,
  `create unique index "budgets_household_id_name_lower_unique" on "budgets" ("household_id", lower("name")) where "deleted_at" is null;`,

  `
    create table "planing_horizons" (
      "id" uuid not null default gen_random_uuid(),
      "name" varchar(255) not null,
      "description" text,
      "amount" decimal(19, 2) not null,
      "currency" currency_enum not null,
      "period_type" period_type_enum not null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz,
      "budget_id" uuid not null,
      "is_archived" boolean not null default false,
      constraint "planing_horizons_pkey" primary key ("id")
    );
  `,
  `
    alter table "planing_horizons" add constraint "planing_horizons_budget_id_foreign"
      foreign key ("budget_id") references "budgets" ("id") on update cascade on delete restrict;
  `,
  `create index "planing_horizons_budget_id_index" on "planing_horizons" ("budget_id");`,
  `create unique index "planing_horizons_budget_id_name_lower_unique" on "planing_horizons" ("budget_id", lower("name")) where "deleted_at" is null and not "is_archived";`,

  `
    create table "planing_horizon_categories" (
      "planing_horizon_id" uuid not null,
      "category_id" uuid not null,
      constraint "planing_horizon_categories_pkey" primary key ("planing_horizon_id", "category_id")
    );
  `,
  `
    alter table "planing_horizon_categories"
      add constraint "planing_horizon_categories_planing_horizon_id_foreign"
      foreign key ("planing_horizon_id") references "planing_horizons" ("id") on update cascade on delete cascade,
      add constraint "planing_horizon_categories_category_id_foreign"
      foreign key ("category_id") references "categories" ("id") on update cascade on delete cascade;
  `,
  `create index "planing_horizon_categories_planing_horizon_id_index" on "planing_horizon_categories" ("planing_horizon_id");`,
  `create index "planing_horizon_categories_category_id_index" on "planing_horizon_categories" ("category_id");`,
];

// HAN-24: per-category spending limits replace budgets and planning horizons,
// which no client used. Production holds no rows in the legacy tables (owner,
// 2026-11-15); the guard covers other environments. A limit is versioned:
// a version applies on [effective_from, effective_to), at most one is open
// per category, and the service keeps versions from overlapping.
export class Migration20261115120000_ReplaceBudgetsWithCategoryLimits extends Migration {
  override up(): void {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`set local statement_timeout = '60s';`);
    this.addSql(LEGACY_ROWS_GUARD_SQL);
    // No client uses these tables or the type, and the guard has seen them empty.
    this.addSql(`
      -- squawk-ignore ban-drop-table
      drop table "planing_horizon_categories", "planing_horizons", "budgets";
    `);
    this.addSql(`
      -- squawk-ignore ban-drop-type
      drop type "period_type_enum";
    `);

    this.addSql(
      `create type "limit_period_type" as enum ('MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'YEARLY');`,
    );
    this.addSql(`
      create table "category_limits" (
        "id" uuid not null default gen_random_uuid(),
        "household_id" uuid not null,
        "category_id" uuid not null,
        "period_type" "limit_period_type" not null,
        "amount" numeric(19,2) not null,
        "currency" "currency_enum" not null,
        "effective_from" date not null,
        "effective_to" date null,
        "created_by_id" uuid null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        primary key ("id"),
        constraint "category_limits_amount_positive" check (amount > 0),
        constraint "category_limits_effective_range" check (effective_to is null or effective_to > effective_from)
      );
    `);
    this.addSql(`
      alter table "category_limits"
        add constraint "category_limits_household_id_fkey"
        foreign key ("household_id") references "households" ("id")
        on update cascade on delete cascade,
        add constraint "category_limits_category_id_fkey"
        foreign key ("category_id") references "categories" ("id")
        on update cascade on delete cascade,
        add constraint "category_limits_created_by_id_fkey"
        foreign key ("created_by_id") references "users" ("id")
        on update cascade on delete set null;
    `);
    // One open version per category.
    this.addSql(
      `create unique index "category_limits_category_open_unique" on "category_limits" ("category_id") where "effective_to" is null;`,
    );
    this.addSql(
      `create index "category_limits_household_category_from_index" on "category_limits" ("household_id", "category_id", "effective_from");`,
    );
    // Every foreign key to users is indexed (see Migration20261010130000).
    this.addSql(
      `create index "category_limits_created_by_id_index" on "category_limits" ("created_by_id");`,
    );
  }

  override down(): void {
    this.addSql(`drop table if exists "category_limits";`);
    this.addSql(`drop type if exists "limit_period_type";`);
    for (const query of LEGACY_SCHEMA_SQL) this.addSql(query);
  }
}
