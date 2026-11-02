import { Migration } from '@mikro-orm/migrations';

export class Migration20260603120000_CreateHouseholdTables extends Migration {
  override up(): void {
    this.addSql(`
      create table "households" (
        "id"         uuid         not null default gen_random_uuid(),
        "name"       varchar(255) not null,
        "created_by" uuid         not null,
        "created_at" timestamptz  not null default now(),
        "deleted_at" timestamptz  null,
        constraint "households_pkey" primary key ("id"),
        constraint "households_created_by_fkey"
          foreign key ("created_by") references "users"("id")
      );
    `);

    this.addSql(`
      create table "household_members" (
        "household_id" uuid        not null,
        "user_id"      uuid        not null,
        "role"         varchar(20) not null default 'member',
        "joined_at"    timestamptz not null default now(),
        constraint "household_members_pkey"
          primary key ("household_id", "user_id"),
        constraint "household_members_household_id_fkey"
          foreign key ("household_id") references "households"("id") on delete cascade,
        constraint "household_members_user_id_fkey"
          foreign key ("user_id") references "users"("id") on delete cascade
      );
      create index "household_members_user_id_idx"
        on "household_members"("user_id");
    `);

    this.addSql(`
      create table "household_invites" (
        "id"             uuid         not null default gen_random_uuid(),
        "household_id"   uuid         not null,
        "invitee_email"  varchar(255) not null,
        "invited_by"     uuid         not null,
        "token_hash"     varchar(64)  not null,
        "status"         varchar(20)  not null default 'pending',
        "expires_at"     timestamptz  not null,
        "created_at"     timestamptz  not null default now(),
        constraint "household_invites_pkey"          primary key ("id"),
        constraint "household_invites_token_hash_key" unique ("token_hash"),
        constraint "household_invites_household_id_fkey"
          foreign key ("household_id") references "households"("id") on delete cascade,
        constraint "household_invites_invited_by_fkey"
          foreign key ("invited_by") references "users"("id")
      );
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists "household_invites";`);
    this.addSql(`drop table if exists "household_members";`);
    this.addSql(`drop table if exists "households";`);
  }
}
