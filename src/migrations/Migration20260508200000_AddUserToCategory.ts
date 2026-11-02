import { Migration } from '@mikro-orm/migrations';

export class Migration20260508200000_AddUserToCategory extends Migration {
  override up(): void {
    // Safe to ADD COLUMN NOT NULL because TRUNCATE wipes all rows first.
    // No production data yet. Dev data gets re-seeded on next login.
    this.addSql('truncate table "categories" cascade;');

    this.addSql('alter table "categories" add column "user_id" uuid not null;');
    this.addSql(
      `alter table "categories"
       add constraint "categories_user_id_foreign"
       foreign key ("user_id") references "users" ("id")
       on update cascade on delete cascade;`,
    );
    this.addSql(
      'create index "categories_user_id_index" on "categories" ("user_id");',
    );
  }

  override down(): void {
    this.addSql('drop index if exists "categories_user_id_index";');
    this.addSql(
      'alter table "categories" drop constraint if exists "categories_user_id_foreign";',
    );
    this.addSql('alter table "categories" drop column if exists "user_id";');
  }
}
