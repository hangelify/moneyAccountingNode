import { Migration } from '@mikro-orm/migrations';

export class Migration20261011130000_NormalizeEmails extends Migration {
  override up(): void {
    // Accounts whose emails differ only in case or surrounding spaces cannot
    // be merged automatically: stop and resolve them by hand first.
    this.addSql(`
      do $$
      declare
        dups text;
      begin
        select string_agg(e, ', ') into dups from (
          select lower(trim("email")) as e from "users"
          group by 1 having count(*) > 1
        ) d;
        if dups is not null then
          raise exception 'users with case-insensitive duplicate emails: %', dups;
        end if;
      end $$;
    `);

    this.addSql(
      `update "users" set "email" = lower(trim("email")) where "email" <> lower(trim("email"));`,
    );
    this.addSql(`drop index if exists "users_email_unique";`);
    this.addSql(
      `create unique index "users_email_lower_unique" on "users" (lower("email"));`,
    );

    this.addSql(
      `update "household_invites" set "invitee_email" = lower(trim("invitee_email")) where "invitee_email" <> lower(trim("invitee_email"));`,
    );
  }

  override down(): void {
    // Emails stay normalized: the original case is not kept.
    this.addSql(`drop index if exists "users_email_lower_unique";`);
    this.addSql(
      `create unique index "users_email_unique" on "users" ("email");`,
    );
  }
}
