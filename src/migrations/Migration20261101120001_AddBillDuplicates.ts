import { Migration } from '@mikro-orm/migrations';

export class Migration20261101120001_AddBillDuplicates extends Migration {
  override up(): void {
    // A duplicate stays in the table, linked to the bill it copies;
    // receipt identity (register, number, time) is what the finder matches on.
    this.addSql(`
      alter table "bills"
        add column "duplicate_of_id" uuid null,
        add column "fiscal_register_id" varchar(64) null,
        add column "fiscal_receipt_number" varchar(64) null,
        add column "purchase_time" time null;
    `);
    // No action, not set null: a hard delete must not leave a duplicate
    // without its original. Bills are only soft-deleted.
    this.addSql(`
      alter table "bills"
        add constraint "bills_duplicate_of_id_foreign"
        foreign key ("duplicate_of_id") references "bills" ("id")
        on update cascade on delete no action;
    `);
    // Compared as text: this runs in the same transaction as the migration
    // that adds 'duplicate' to the enum, where the new value is not usable.
    this.addSql(`
      alter table "bills"
        add constraint "bills_duplicate_of_check"
        check ((status::text = 'duplicate') = (duplicate_of_id is not null));
    `);
    this.addSql(
      `create index "bills_duplicate_of_id_index" on "bills" ("duplicate_of_id") where "duplicate_of_id" is not null;`,
    );
    // Not unique: "keep both" must stay possible and a number can be misread.
    this.addSql(
      `create index "bills_household_fiscal_index" on "bills" ("household_id", "fiscal_register_id", "fiscal_receipt_number") where "deleted_at" is null and "fiscal_receipt_number" is not null;`,
    );

    // A pair the user said is not a duplicate. Each pair is stored once, the
    // smaller id first, so a second dismissal is a no-op.
    this.addSql(`
      create table "bill_duplicate_dismissals" (
        "id" uuid not null default gen_random_uuid(),
        "household_id" uuid not null,
        "bill_id" uuid not null,
        "other_bill_id" uuid not null,
        "dismissed_by_user_id" uuid null,
        "created_at" timestamptz not null default now(),
        primary key ("id"),
        constraint "bill_duplicate_dismissals_order_check"
          check ("bill_id" < "other_bill_id")
      );
    `);
    this.addSql(`
      alter table "bill_duplicate_dismissals"
        add constraint "bill_duplicate_dismissals_household_id_foreign"
        foreign key ("household_id") references "households" ("id")
        on update cascade,
        add constraint "bill_duplicate_dismissals_bill_id_foreign"
        foreign key ("bill_id") references "bills" ("id")
        on update cascade,
        add constraint "bill_duplicate_dismissals_other_bill_id_foreign"
        foreign key ("other_bill_id") references "bills" ("id")
        on update cascade,
        add constraint "bill_duplicate_dismissals_dismissed_by_user_id_foreign"
        foreign key ("dismissed_by_user_id") references "users" ("id")
        on update cascade on delete set null;
    `);
    this.addSql(
      `create unique index "bill_duplicate_dismissals_pair_unique" on "bill_duplicate_dismissals" ("bill_id", "other_bill_id");`,
    );
    // Every foreign key is indexed (see Migration20261010130000); bill_id is
    // the leading column of the unique index.
    this.addSql(
      `create index "bill_duplicate_dismissals_other_bill_id_index" on "bill_duplicate_dismissals" ("other_bill_id");`,
    );
    this.addSql(
      `create index "bill_duplicate_dismissals_household_id_index" on "bill_duplicate_dismissals" ("household_id");`,
    );
    this.addSql(
      `create index "bill_duplicate_dismissals_dismissed_by_user_id_index" on "bill_duplicate_dismissals" ("dismissed_by_user_id");`,
    );
  }

  override down(): void {
    this.addSql(`drop table if exists "bill_duplicate_dismissals";`);
    this.addSql(`drop index if exists "bills_household_fiscal_index";`);
    this.addSql(`drop index if exists "bills_duplicate_of_id_index";`);
    this.addSql(`
      alter table "bills"
        drop constraint if exists "bills_duplicate_of_check",
        drop constraint if exists "bills_duplicate_of_id_foreign",
        drop column if exists "purchase_time",
        drop column if exists "fiscal_receipt_number",
        drop column if exists "fiscal_register_id",
        drop column if exists "duplicate_of_id";
    `);
  }
}
