import { Migration } from '@mikro-orm/migrations';

export class Migration20260521120000_ExtendBillSubCategoryTable extends Migration {
  override up(): void {
    // Drop old unique constraint — won't work correctly once sub_category_id is nullable
    this.addSql(
      `drop index if exists "bill_sub_categories_bill_sub_category_unique";`,
    );

    // Make sub_category_id nullable
    this.addSql(`
      alter table "bill_sub_categories"
        alter column "sub_category_id" drop not null;
    `);

    // Add new columns (raw_name uses a temporary default so existing rows don't violate NOT NULL)
    this.addSql(`
      alter table "bill_sub_categories"
        add column "raw_name" varchar(255) not null default '',
        add column "unit" varchar(10),
        add column "price_per_unit" decimal(10, 2),
        add column "category_confidence" decimal(5, 4),
        add column "category_reasoning" text;
    `);

    // Remove temporary default — new rows must supply raw_name explicitly
    this.addSql(`
      alter table "bill_sub_categories"
        alter column "raw_name" drop default;
    `);

    // Partial unique index: one row per (bill_id, sub_category_id) for categorized items only
    this.addSql(`
      create unique index "bill_sub_categories_bill_sub_category_unique"
        on "bill_sub_categories" ("bill_id", "sub_category_id")
        where sub_category_id is not null;
    `);

    // Drop the old non-partial indexes on bsc — the new partial index on sub_category_id
    // replaces the non-partial one; the bill_id index is recreated with a better name below.
    this.addSql(`drop index if exists "bill_sub_categories_bill_id_index";`);
    this.addSql(
      `drop index if exists "bill_sub_categories_sub_category_id_index";`,
    );

    // Dashboard query index: equality on user_id + status, range on bill_date
    this.addSql(`
      create index "bills_user_status_date_index"
        on "bills" ("user_id", "status", "bill_date")
        where deleted_at is null;
    `);

    this.addSql(`
      create index "bill_sub_categories_bill_id_index"
        on "bill_sub_categories" ("bill_id");
    `);

    this.addSql(`
      create index "bill_sub_categories_sub_category_id_partial_index"
        on "bill_sub_categories" ("sub_category_id")
        where sub_category_id is not null;
    `);
  }

  override down(): void {
    // NOTE: this rollback will fail with "column contains null values" if any uncategorized
    // bill_sub_categories rows (sub_category_id IS NULL) exist in the database. Safe only
    // on a fresh install or before any uncategorized data has been written.
    this.addSql(
      `drop index if exists "bill_sub_categories_sub_category_id_partial_index";`,
    );
    // Drop the index created by this migration's up() before recreating the original below.
    this.addSql(`drop index if exists "bill_sub_categories_bill_id_index";`);
    this.addSql(`drop index if exists "bills_user_status_date_index";`);
    // Restore the original (pre-migration) non-partial indexes.
    // Note: bill_sub_categories_bill_id_index shares a name with the one just dropped —
    // this is intentional; we're restoring the pre-migration version of that index.
    this.addSql(`
      create index "bill_sub_categories_bill_id_index"
        on "bill_sub_categories" ("bill_id");
    `);
    this.addSql(`
      create index "bill_sub_categories_sub_category_id_index"
        on "bill_sub_categories" ("sub_category_id");
    `);
    this.addSql(
      `drop index if exists "bill_sub_categories_bill_sub_category_unique";`,
    );
    this.addSql(`
      alter table "bill_sub_categories"
        drop column if exists "category_reasoning",
        drop column if exists "category_confidence",
        drop column if exists "price_per_unit",
        drop column if exists "unit",
        drop column if exists "raw_name";
    `);
    this.addSql(`
      alter table "bill_sub_categories"
        alter column "sub_category_id" set not null;
    `);
    this.addSql(`
      create unique index "bill_sub_categories_bill_sub_category_unique"
        on "bill_sub_categories" ("bill_id", "sub_category_id");
    `);
  }
}
