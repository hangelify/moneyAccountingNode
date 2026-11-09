import { Migration } from '@mikro-orm/migrations';

// The client's key for one submit of the manual quick-entry form (HAN-48):
// a replay of the same submit finds its bills instead of saving copies. The
// unique index keeps deleted bills too, so a replay never brings them back.
export class Migration20261109150000_AddBillClientBatch extends Migration {
  override up(): void {
    this.addSql(
      `alter table "bills" add column "client_batch_id" uuid null, add column "client_batch_index" smallint null;`,
    );
    this.addSql(
      `alter table "bills" add constraint "bills_client_batch_check" check ((client_batch_id is null) = (client_batch_index is null));`,
    );
    this.addSql(
      `create unique index "bills_household_client_batch_unique" on "bills" ("household_id", "client_batch_id", "client_batch_index") where "client_batch_id" is not null;`,
    );
  }

  override down(): void {
    this.addSql(`drop index if exists "bills_household_client_batch_unique";`);
    this.addSql(
      `alter table "bills" drop constraint if exists "bills_client_batch_check";`,
    );
    this.addSql(
      `alter table "bills" drop column "client_batch_id", drop column "client_batch_index";`,
    );
  }
}
