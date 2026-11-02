import { Migration } from '@mikro-orm/migrations';

export class Migration20251225120001_CreateLogsTable extends Migration {
  override up(): void {
    // Create log_level enum
    this.addSql(`
      create type "log_level_enum" as enum ('DEBUG', 'INFO', 'WARN', 'ERROR');
    `);

    // Create log_source enum
    this.addSql(`
      create type "log_source_enum" as enum ('BACKEND', 'FRONTEND', 'API', 'AUTH', 'DATABASE');
    `);

    // Create logs table
    this.addSql(`
      create table "logs" (
        "id" uuid not null default gen_random_uuid(),
        "level" log_level_enum not null,
        "source" log_source_enum not null,
        "context" varchar(255),
        "message" text not null,
        "metadata" jsonb,
        "user_id" uuid,
        "ip_address" varchar(45),
        "user_agent" text,
        "endpoint" varchar(255),
        "http_method" varchar(10),
        "status_code" integer,
        "created_at" timestamptz not null default now(),
        constraint "logs_pkey" primary key ("id")
      );
    `);

    // Add foreign key to users
    this.addSql(`
      alter table "logs" 
      add constraint "logs_user_id_foreign" 
      foreign key ("user_id") references "users" ("id") on update cascade on delete set null;
    `);

    // Add indexes for better query performance
    this.addSql(`
      create index "logs_level_index" on "logs" ("level");
    `);

    this.addSql(`
      create index "logs_source_index" on "logs" ("source");
    `);

    this.addSql(`
      create index "logs_context_index" on "logs" ("context");
    `);

    this.addSql(`
      create index "logs_created_at_index" on "logs" ("created_at");
    `);

    this.addSql(`
      create index "logs_user_id_index" on "logs" ("user_id");
    `);
  }

  override down(): void {
    this.addSql(`drop index if exists "logs_user_id_index";`);
    this.addSql(`drop index if exists "logs_created_at_index";`);
    this.addSql(`drop index if exists "logs_context_index";`);
    this.addSql(`drop index if exists "logs_source_index";`);
    this.addSql(`drop index if exists "logs_level_index";`);
    this.addSql(
      `alter table "logs" drop constraint if exists "logs_user_id_foreign";`,
    );
    this.addSql(`drop table if exists "logs";`);
    this.addSql(`drop type if exists "log_source_enum";`);
    this.addSql(`drop type if exists "log_level_enum";`);
  }
}
