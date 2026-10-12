import { Migration } from '@mikro-orm/migrations';

export class Migration20261012100000_AddEmailVerification extends Migration {
  override up(): void {
    // Existing users stay unverified: an address claimed before this change
    // was never proven to belong to its account.
    this.addSql(`
      alter table "users"
        add column "email_verified_at" timestamptz null,
        add column "email_verification_token_hash" varchar(64) null,
        add column "email_verification_expires_at" timestamptz null,
        add column "email_verification_sent_at" timestamptz null;
    `);
    this.addSql(`
      create unique index "users_email_verification_token_hash_unique"
        on "users" ("email_verification_token_hash")
        where "email_verification_token_hash" is not null;
    `);
  }

  override down(): void {
    this.addSql(
      `drop index if exists "users_email_verification_token_hash_unique";`,
    );
    this.addSql(`
      alter table "users"
        drop column if exists "email_verification_sent_at",
        drop column if exists "email_verification_expires_at",
        drop column if exists "email_verification_token_hash",
        drop column if exists "email_verified_at";
    `);
  }
}
