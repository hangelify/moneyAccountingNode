import { Migration } from '@mikro-orm/migrations';

// Indexes lost when MigrateOwnershipToHouseholds dropped the user_id columns
// (bills_user_id_index, bills_user_status_date_index, categories_user_id_index),
// indexes on the foreign keys to users (hard user delete scans each table),
// and write-only indexes that no query uses.
//
// Plain (transactional) CREATE INDEX: the migrator runs all pending migrations
// in one transaction (allOrNothing), while a non-transactional migration runs
// on another connection, so CONCURRENTLY would not see tables created earlier
// in the same batch (migration:fresh, the e2e harness). On a large production
// database, create the indexes beforehand with CREATE INDEX CONCURRENTLY and
// the same names and definitions; "if not exists" then makes this a no-op.
// Check pg_index.indisvalid first: a failed CONCURRENTLY build leaves an
// invalid index under that name, which "if not exists" would keep.
export class Migration20261010130000_AddHouseholdAndForeignKeyIndexes extends Migration {
  override up(): void {
    // Household-scoped reads. Full index, not partial on deleted_at: the
    // parse-photo sub-category load does not filter categories.deleted_at,
    // so a partial index would not be used.
    this.addSql(
      `create index if not exists "categories_household_id_index" on "categories" ("household_id");`,
    );
    // Dashboard, bill list and listDrafts: equality on household + status,
    // range / order on bill_date. The partial (deleted_at is null) indexes
    // serve the app's queries but not FK checks: bills and markets are only
    // soft-deleted, a hard delete of a market or household would scan them.
    this.addSql(
      `create index if not exists "bills_household_status_date_index" on "bills" ("household_id", "status", "bill_date" desc) where "deleted_at" is null;`,
    );
    this.addSql(
      `create index if not exists "bills_market_id_index" on "bills" ("market_id") where "deleted_at" is null;`,
    );
    this.addSql(
      `create index if not exists "markets_household_id_index" on "markets" ("household_id") where "deleted_at" is null;`,
    );
    this.addSql(
      `create index if not exists "household_invites_household_id_index" on "household_invites" ("household_id");`,
    );

    // Foreign keys to users. ai_requests (user_id, created_at) already exists
    // (Migration20261010120000_AddAiRequestsUserCreatedAtIndex).
    this.addSql(
      `create index if not exists "bills_created_by_user_id_index" on "bills" ("created_by_user_id");`,
    );
    this.addSql(
      `create index if not exists "households_created_by_index" on "households" ("created_by");`,
    );
    this.addSql(
      `create index if not exists "household_invites_invited_by_index" on "household_invites" ("invited_by");`,
    );

    // Write-only indexes: 1-3 distinct values per table, or (bill_date) where
    // every query filters by household first. In place of the (status) index,
    // a small partial index over in-flight requests, for finding stuck
    // PENDING ones (no query uses it yet). Status updates stay non-HOT: the
    // predicate column counts as indexed.
    this.addSql(`drop index if exists "ai_requests_status_index";`);
    this.addSql(
      `create index if not exists "ai_requests_pending_index" on "ai_requests" ("created_at") where "status" = 'PENDING';`,
    );
    this.addSql(`drop index if exists "ai_requests_task_name_index";`);
    this.addSql(
      `drop index if exists "ai_request_attempts_provider_name_index";`,
    );
    this.addSql(`drop index if exists "sessions_is_active_index";`);
    this.addSql(`drop index if exists "bills_bill_date_index";`);
  }

  override down(): void {
    this.addSql(
      `create index if not exists "bills_bill_date_index" on "bills" ("bill_date");`,
    );
    this.addSql(
      `create index if not exists "sessions_is_active_index" on "sessions" ("is_active");`,
    );
    this.addSql(
      `create index if not exists "ai_request_attempts_provider_name_index" on "ai_request_attempts" ("provider_name");`,
    );
    this.addSql(
      `create index if not exists "ai_requests_task_name_index" on "ai_requests" ("task_name");`,
    );
    this.addSql(`drop index if exists "ai_requests_pending_index";`);
    this.addSql(
      `create index if not exists "ai_requests_status_index" on "ai_requests" ("status");`,
    );

    this.addSql(`drop index if exists "household_invites_invited_by_index";`);
    this.addSql(`drop index if exists "households_created_by_index";`);
    this.addSql(`drop index if exists "bills_created_by_user_id_index";`);

    this.addSql(`drop index if exists "household_invites_household_id_index";`);
    this.addSql(`drop index if exists "markets_household_id_index";`);
    this.addSql(`drop index if exists "bills_market_id_index";`);
    this.addSql(`drop index if exists "bills_household_status_date_index";`);
    this.addSql(`drop index if exists "categories_household_id_index";`);
  }
}
