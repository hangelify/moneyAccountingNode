import { Migration } from '@mikro-orm/migrations';

export class Migration20251225120003_CreateRefreshTokensTable extends Migration {
  override up(): void {
    // Create refresh_tokens table
    this.addSql(`
      create table "refresh_tokens" (
        "id" uuid not null default gen_random_uuid(),
        "user_id" uuid not null,
        "token" varchar(500) not null,
        "family_id" varchar(255),
        "ip_address" varchar(45),
        "user_agent" text,
        "created_at" timestamptz not null default now(),
        "expires_at" timestamptz not null,
        "used_at" timestamptz,
        "is_active" boolean not null default true,
        "is_revoked" boolean not null default false,
        constraint "refresh_tokens_pkey" primary key ("id")
      );
    `);

    // Add foreign key to users
    this.addSql(`
      alter table "refresh_tokens" 
      add constraint "refresh_tokens_user_id_foreign" 
      foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;
    `);

    // Add unique constraint on token
    this.addSql(`
      create unique index "refresh_tokens_token_unique" on "refresh_tokens" ("token");
    `);

    // Add indexes for better query performance
    this.addSql(`
      create index "refresh_tokens_user_id_index" on "refresh_tokens" ("user_id");
    `);

    this.addSql(`
      create index "refresh_tokens_token_index" on "refresh_tokens" ("token");
    `);

    this.addSql(`
      create index "refresh_tokens_family_id_index" on "refresh_tokens" ("family_id");
    `);

    this.addSql(`
      create index "refresh_tokens_is_active_index" on "refresh_tokens" ("is_active");
    `);

    this.addSql(`
      create index "refresh_tokens_is_revoked_index" on "refresh_tokens" ("is_revoked");
    `);

    this.addSql(`
      create index "refresh_tokens_expires_at_index" on "refresh_tokens" ("expires_at");
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists "refresh_tokens_expires_at_index";`);
    this.addSql(`drop index if exists "refresh_tokens_is_revoked_index";`);
    this.addSql(`drop index if exists "refresh_tokens_is_active_index";`);
    this.addSql(`drop index if exists "refresh_tokens_family_id_index";`);
    this.addSql(`drop index if exists "refresh_tokens_token_index";`);
    this.addSql(`drop index if exists "refresh_tokens_user_id_index";`);
    this.addSql(`drop index if exists "refresh_tokens_token_unique";`);
    this.addSql(
      `alter table "refresh_tokens" drop constraint if exists "refresh_tokens_user_id_foreign";`,
    );
    this.addSql(`drop table if exists "refresh_tokens";`);
  }
}
