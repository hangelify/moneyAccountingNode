import { Migration } from '@mikro-orm/migrations';

export class Migration20261011170000_AddAiRequestRetentionColumns extends Migration {
  override up(): void {
    // The retention job nulls the prompt once the raw-payload period is over.
    this.addSql(
      `alter table "ai_requests" alter column "prompt" drop not null;`,
    );
    this.addSql(
      `alter table "ai_requests" add column "household_id" uuid null;`,
    );
    this.addSql(`
      alter table "ai_requests" add constraint "ai_requests_household_id_foreign"
        foreign key ("household_id") references "households" ("id")
        on update cascade on delete set null;
    `);
    this.addSql(
      `create index "ai_requests_household_id_index" on "ai_requests" ("household_id");`,
    );
    // Requests still holding raw payloads, oldest first: scrubbed rows drop
    // out of the index, so each retention run only visits new work.
    this.addSql(`
      create index "ai_requests_unscrubbed_created_index"
        on "ai_requests" ("created_at") where "prompt" is not null;
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists "ai_requests_unscrubbed_created_index";`);
    this.addSql(`drop index if exists "ai_requests_household_id_index";`);
    this.addSql(
      `alter table "ai_requests" drop constraint if exists "ai_requests_household_id_foreign";`,
    );
    this.addSql(
      `alter table "ai_requests" drop column if exists "household_id";`,
    );
    this.addSql(
      `update "ai_requests" set "prompt" = '{"messages":[]}' where "prompt" is null;`,
    );
    this.addSql(
      `alter table "ai_requests" alter column "prompt" set not null;`,
    );
  }
}
