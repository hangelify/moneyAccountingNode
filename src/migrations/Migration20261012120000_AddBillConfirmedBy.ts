import { Migration } from '@mikro-orm/migrations';

export class Migration20261012120000_AddBillConfirmedBy extends Migration {
  override up(): void {
    // Not backfilled: confirm used to overwrite created_by with the confirming
    // user, so who uploaded those drafts is no longer known.
    this.addSql(`
      alter table "bills"
        add column "confirmed_by_user_id" uuid null,
        add column "confirmed_at" timestamptz null;
    `);
    this.addSql(`
      alter table "bills"
        add constraint "bills_confirmed_by_user_id_foreign"
        foreign key ("confirmed_by_user_id") references "users" ("id")
        on update cascade on delete set null;
    `);
    // Every foreign key to users is indexed, so deleting a user does not
    // scan bills (see Migration20261010130000).
    this.addSql(
      `create index "bills_confirmed_by_user_id_index" on "bills" ("confirmed_by_user_id");`,
    );
  }

  override down(): void {
    this.addSql(`drop index if exists "bills_confirmed_by_user_id_index";`);
    this.addSql(`
      alter table "bills"
        drop constraint if exists "bills_confirmed_by_user_id_foreign",
        drop column if exists "confirmed_at",
        drop column if exists "confirmed_by_user_id";
    `);
  }
}
