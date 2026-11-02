import { Migration } from '@mikro-orm/migrations';

export class Migration20251230141421_AddUserIdToBudgets extends Migration {
  override up(): void {
    // Add user_id column to budgets table
    this.addSql(`
      alter table "budgets" 
      add column "user_id" uuid not null;
    `);

    // Add foreign key constraint
    this.addSql(`
      alter table "budgets" 
      add constraint "budgets_user_id_foreign" 
      foreign key ("user_id") references "users" ("id") on update cascade on delete restrict;
    `);

    // Add unique constraint for name per user (excluding soft-deleted budgets)
    // Note: This is a partial unique index that excludes deleted budgets
    this.addSql(`
      create unique index "budgets_user_id_name_unique" 
      on "budgets" ("user_id", "name") 
      where "deleted_at" is null;
    `);

    // Add index for better query performance
    this.addSql(`
      create index "budgets_user_id_index" on "budgets" ("user_id");
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists "budgets_user_id_index";`);
    this.addSql(`drop index if exists "budgets_user_id_name_unique";`);
    this.addSql(
      `alter table "budgets" drop constraint if exists "budgets_user_id_foreign";`,
    );
    this.addSql(`alter table "budgets" drop column if exists "user_id";`);
  }
}
