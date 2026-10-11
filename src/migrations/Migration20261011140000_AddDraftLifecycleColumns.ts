import { Migration } from '@mikro-orm/migrations';

export class Migration20261011140000_AddDraftLifecycleColumns extends Migration {
  override up(): void {
    this.addSql(`
      alter table "bills"
        add column "bill_date_inferred" boolean not null default false,
        add column "image_sha256" varchar(64) null,
        add column "ai_request_id" uuid null;
    `);
    this.addSql(`
      alter table "bills" add constraint "bills_ai_request_id_foreign"
        foreign key ("ai_request_id") references "ai_requests" ("id")
        on update cascade on delete set null;
    `);
    this.addSql(
      `create index "bills_ai_request_id_index" on "bills" ("ai_request_id");`,
    );
    // Drafts page and count, newest first.
    this.addSql(`
      create index "bills_household_drafts_created_index"
        on "bills" ("household_id", "created_at" desc, "id" desc)
        where "status" = 'draft' and "deleted_at" is null;
    `);
    // One open draft per receipt photo in a household.
    this.addSql(`
      create unique index "bills_household_image_sha256_draft_unique"
        on "bills" ("household_id", "image_sha256")
        where "status" = 'draft' and "deleted_at" is null and "image_sha256" is not null;
    `);
  }

  override down(): void {
    this.addSql(
      `drop index if exists "bills_household_image_sha256_draft_unique";`,
    );
    this.addSql(`drop index if exists "bills_household_drafts_created_index";`);
    this.addSql(`drop index if exists "bills_ai_request_id_index";`);
    this.addSql(
      `alter table "bills" drop constraint if exists "bills_ai_request_id_foreign";`,
    );
    this.addSql(`
      alter table "bills"
        drop column if exists "ai_request_id",
        drop column if exists "image_sha256",
        drop column if exists "bill_date_inferred";
    `);
  }
}
