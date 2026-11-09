import { Migration } from '@mikro-orm/migrations';

export class Migration20261102120001_AddBillBatches extends Migration {
  override up(): void {
    this.addSql(
      `create type "bill_parse_error_enum" as enum ('not_a_receipt', 'ai_failed', 'save_failed');`,
    );
    this.addSql(
      `create type "bill_batch_item_status_enum" as enum ('queued', 'processing', 'done', 'failed');`,
    );

    this.addSql(`
      alter table "bills"
        add column "parse_error_code" "bill_parse_error_enum" null,
        add column "parse_error_message" text null,
        add column "image_key" varchar(255) null;
    `);
    // Compared as text: this runs in the same transaction as the migration
    // that adds 'failed' to the enum, where the new value is not usable.
    this.addSql(`
      alter table "bills"
        add constraint "bills_parse_error_check"
        check ((status::text = 'failed') = (parse_error_code is not null));
    `);

    this.addSql(`
      create table "bill_batches" (
        "id" uuid not null default gen_random_uuid(),
        "household_id" uuid not null,
        "created_by_user_id" uuid null,
        "total" int not null,
        "created_at" timestamptz not null default now(),
        primary key ("id")
      );
    `);
    this.addSql(`
      alter table "bill_batches"
        add constraint "bill_batches_household_id_foreign"
        foreign key ("household_id") references "households" ("id")
        on update cascade,
        add constraint "bill_batches_created_by_user_id_foreign"
        foreign key ("created_by_user_id") references "users" ("id")
        on update cascade on delete set null;
    `);
    // Every foreign key is indexed (see Migration20261010130000).
    this.addSql(
      `create index "bill_batches_household_id_index" on "bill_batches" ("household_id");`,
    );
    this.addSql(
      `create index "bill_batches_created_by_user_id_index" on "bill_batches" ("created_by_user_id");`,
    );

    this.addSql(`
      create table "bill_batch_items" (
        "id" uuid not null default gen_random_uuid(),
        "batch_id" uuid not null,
        "position" int not null,
        "image_key" varchar(255) not null,
        "image_sha256" varchar(64) not null,
        "status" "bill_batch_item_status_enum" not null default 'queued',
        "bill_id" uuid null,
        "updated_at" timestamptz not null default now(),
        primary key ("id")
      );
    `);
    this.addSql(`
      alter table "bill_batch_items"
        add constraint "bill_batch_items_batch_id_foreign"
        foreign key ("batch_id") references "bill_batches" ("id")
        on update cascade on delete cascade,
        add constraint "bill_batch_items_bill_id_foreign"
        foreign key ("bill_id") references "bills" ("id")
        on update cascade on delete set null;
    `);
    // batch_id is the leading column of the unique index.
    this.addSql(
      `alter table "bill_batch_items" add constraint "bill_batch_items_batch_id_position_unique" unique ("batch_id", "position");`,
    );
    this.addSql(
      `create index "bill_batch_items_bill_id_index" on "bill_batch_items" ("bill_id");`,
    );
  }

  override down(): void {
    // Failed bills would violate the check once the columns are gone and
    // cannot keep their status; they are removed with their batch items.
    this.addSql(`drop table if exists "bill_batch_items";`);
    this.addSql(`drop table if exists "bill_batches";`);
    this.addSql(`delete from "bills" where "status"::text = 'failed';`);
    this.addSql(`
      alter table "bills"
        drop constraint if exists "bills_parse_error_check",
        drop column if exists "image_key",
        drop column if exists "parse_error_message",
        drop column if exists "parse_error_code";
    `);
    this.addSql(`drop type if exists "bill_batch_item_status_enum";`);
    this.addSql(`drop type if exists "bill_parse_error_enum";`);
  }
}
