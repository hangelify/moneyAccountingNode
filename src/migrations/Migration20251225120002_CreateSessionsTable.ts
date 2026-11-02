import { Migration } from '@mikro-orm/migrations';

export class Migration20251225120002_CreateSessionsTable extends Migration {
  override up(): void {
    // Create sessions table
    this.addSql(`
      create table "sessions" (
        "id" uuid not null default gen_random_uuid(),
        "user_id" uuid not null,
        "session_token" varchar(255) not null,
        "ip_address" varchar(45),
        "user_agent" text,
        "created_at" timestamptz not null default now(),
        "expires_at" timestamptz not null,
        "last_activity_at" timestamptz,
        "is_active" boolean not null default true,
        constraint "sessions_pkey" primary key ("id")
      );
    `);

    // Add foreign key to users
    this.addSql(`
      alter table "sessions" 
      add constraint "sessions_user_id_foreign" 
      foreign key ("user_id") references "users" ("id") on update cascade on delete cascade;
    `);

    // Add unique constraint on session_token
    this.addSql(`
      create unique index "sessions_session_token_unique" on "sessions" ("session_token");
    `);

    // Add indexes for better query performance
    this.addSql(`
      create index "sessions_user_id_index" on "sessions" ("user_id");
    `);

    this.addSql(`
      create index "sessions_session_token_index" on "sessions" ("session_token");
    `);

    this.addSql(`
      create index "sessions_is_active_index" on "sessions" ("is_active");
    `);

    this.addSql(`
      create index "sessions_expires_at_index" on "sessions" ("expires_at");
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists "sessions_expires_at_index";`);
    this.addSql(`drop index if exists "sessions_is_active_index";`);
    this.addSql(`drop index if exists "sessions_session_token_index";`);
    this.addSql(`drop index if exists "sessions_user_id_index";`);
    this.addSql(`drop index if exists "sessions_session_token_unique";`);
    this.addSql(
      `alter table "sessions" drop constraint if exists "sessions_user_id_foreign";`,
    );
    this.addSql(`drop table if exists "sessions";`);
  }
}
