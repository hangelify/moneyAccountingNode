import { Migration } from '@mikro-orm/migrations';

export class Migration20260508120000_HardenAuthSessionsAndRefreshTokens extends Migration {
  override up(): void {
    // Invalidate all existing sessions/tokens — schema is breaking (token hash, new fks).
    this.addSql(`truncate table "refresh_tokens" cascade;`);
    this.addSql(`truncate table "sessions" cascade;`);

    // sessions: drop session_token (JWT was stored here; sid is now the opaque session id)
    this.addSql(`drop index if exists "sessions_session_token_unique";`);
    this.addSql(`drop index if exists "sessions_session_token_index";`);
    this.addSql(`alter table "sessions" drop column "session_token";`);

    // sessions: rename expires_at -> absolute_expires_at for clarity
    this.addSql(
      `alter table "sessions" rename column "expires_at" to "absolute_expires_at";`,
    );
    this.addSql(
      `alter index "sessions_expires_at_index" rename to "sessions_absolute_expires_at_index";`,
    );

    // refresh_tokens: drop old raw-token column + derived indexes/columns
    this.addSql(`drop index if exists "refresh_tokens_token_unique";`);
    this.addSql(`drop index if exists "refresh_tokens_token_index";`);
    this.addSql(`drop index if exists "refresh_tokens_family_id_index";`);
    this.addSql(`drop index if exists "refresh_tokens_is_active_index";`);
    this.addSql(`drop index if exists "refresh_tokens_is_revoked_index";`);
    this.addSql(`alter table "refresh_tokens" drop column "token";`);
    this.addSql(`alter table "refresh_tokens" drop column "family_id";`);
    this.addSql(`alter table "refresh_tokens" drop column "is_active";`);
    this.addSql(`alter table "refresh_tokens" drop column "used_at";`);

    // refresh_tokens: add hashed token, jti, session FK
    this.addSql(
      `alter table "refresh_tokens" add column "token_hash" varchar(64) not null;`,
    );
    this.addSql(
      `create unique index "refresh_tokens_token_hash_unique" on "refresh_tokens" ("token_hash");`,
    );

    this.addSql(`alter table "refresh_tokens" add column "jti" uuid not null;`);
    this.addSql(
      `create unique index "refresh_tokens_jti_unique" on "refresh_tokens" ("jti");`,
    );

    this.addSql(
      `alter table "refresh_tokens" add column "session_id" uuid not null;`,
    );
    this.addSql(
      `alter table "refresh_tokens"
       add constraint "refresh_tokens_session_id_foreign"
       foreign key ("session_id") references "sessions" ("id")
       on update cascade on delete cascade;`,
    );
    this.addSql(
      `create index "refresh_tokens_session_id_index" on "refresh_tokens" ("session_id");`,
    );

    this.addSql(
      `create index "refresh_tokens_is_revoked_index" on "refresh_tokens" ("is_revoked");`,
    );
  }

  override down(): void {
    this.addSql(`truncate table "refresh_tokens" cascade;`);
    this.addSql(`truncate table "sessions" cascade;`);

    this.addSql(`drop index if exists "refresh_tokens_is_revoked_index";`);
    this.addSql(`drop index if exists "refresh_tokens_session_id_index";`);
    this.addSql(
      `alter table "refresh_tokens" drop constraint if exists "refresh_tokens_session_id_foreign";`,
    );
    this.addSql(
      `alter table "refresh_tokens" drop column if exists "session_id";`,
    );

    this.addSql(`drop index if exists "refresh_tokens_jti_unique";`);
    this.addSql(`alter table "refresh_tokens" drop column if exists "jti";`);

    this.addSql(`drop index if exists "refresh_tokens_token_hash_unique";`);
    this.addSql(
      `alter table "refresh_tokens" drop column if exists "token_hash";`,
    );

    this.addSql(
      `alter table "refresh_tokens" add column "used_at" timestamptz;`,
    );
    this.addSql(
      `alter table "refresh_tokens" add column "is_active" boolean not null default true;`,
    );
    this.addSql(
      `alter table "refresh_tokens" add column "family_id" varchar(255);`,
    );
    this.addSql(
      `alter table "refresh_tokens" add column "token" varchar(500) not null default '';`,
    );
    this.addSql(
      `create unique index "refresh_tokens_token_unique" on "refresh_tokens" ("token");`,
    );
    this.addSql(
      `create index "refresh_tokens_token_index" on "refresh_tokens" ("token");`,
    );
    this.addSql(
      `create index "refresh_tokens_family_id_index" on "refresh_tokens" ("family_id");`,
    );
    this.addSql(
      `create index "refresh_tokens_is_active_index" on "refresh_tokens" ("is_active");`,
    );

    this.addSql(
      `alter index "sessions_absolute_expires_at_index" rename to "sessions_expires_at_index";`,
    );
    this.addSql(
      `alter table "sessions" rename column "absolute_expires_at" to "expires_at";`,
    );

    this.addSql(
      `alter table "sessions" add column "session_token" varchar(500) not null default '';`,
    );
    this.addSql(
      `create unique index "sessions_session_token_unique" on "sessions" ("session_token");`,
    );
    this.addSql(
      `create index "sessions_session_token_index" on "sessions" ("session_token");`,
    );
  }
}
