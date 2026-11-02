import { Migration } from '@mikro-orm/migrations';

export class Migration20251225120000_AddEmailAndPasswordToUsers extends Migration {
  override up(): void {
    // Add email column (unique, not null)
    this.addSql(`
      alter table "users" 
      add column "email" varchar(255);
    `);

    // Add password column (not null, will be hashed)
    this.addSql(`
      alter table "users" 
      add column "password" varchar(255);
    `);

    // Update existing rows to have email (using username or generating one)
    // This is a migration helper - adjust based on your data
    this.addSql(`
      update "users" 
      set "email" = coalesce("username", 'user_' || "id" || '@example.com')
      where "email" is null;
    `);

    // Make email not null and unique
    this.addSql(`
      alter table "users" 
      alter column "email" set not null;
    `);

    this.addSql(`
      create unique index "users_email_unique" on "users" ("email");
    `);

    // For existing users without password, set a temporary placeholder
    // They will need to reset their password
    this.addSql(`
      update "users" 
      set "password" = '$2b$10$TemporaryPasswordHashForMigrationOnly'
      where "password" is null;
    `);

    // Make password not null (for new registrations)
    // Note: Existing users with temporary password will need to reset it
    this.addSql(`
      alter table "users" 
      alter column "password" set not null;
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists "users_email_unique";`);
    this.addSql(`alter table "users" drop column if exists "email";`);
    this.addSql(`alter table "users" drop column if exists "password";`);
  }
}
