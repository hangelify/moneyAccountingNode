import { Migration } from '@mikro-orm/migrations';

export class Migration20260508140000_CreateAiRequestTables extends Migration {
  override up(): void {
    // Create ai_request_status enum type
    this.addSql(
      `create type "ai_request_status_enum" as enum ('PENDING', 'SUCCESS', 'FAILED');`,
    );

    // Create ai_attempt_status enum type
    this.addSql(
      `create type "ai_attempt_status_enum" as enum ('SUCCESS', 'FAILED');`,
    );

    // Create ai_attempt_error_code enum type
    this.addSql(
      `create type "ai_attempt_error_code_enum" as enum ('TIMEOUT', 'RATE_LIMIT', 'SERVER_ERROR', 'SCHEMA_INVALID', 'INVALID_RESPONSE', 'PROVIDER_ERROR', 'UNKNOWN');`,
    );

    // Create ai_requests table
    this.addSql(`
      create table "ai_requests" (
        "id" uuid not null default gen_random_uuid(),
        "task_name" varchar(128) not null,
        "user_id" uuid,
        "status" "ai_request_status_enum" not null,
        "required_capabilities" jsonb not null,
        "image_s3_keys" jsonb,
        "prompt" jsonb not null,
        "final_output" jsonb,
        "error_message" text,
        "chosen_attempt_id" uuid,
        "total_latency_ms" integer,
        "total_cost_usd" numeric(12, 6),
        "created_at" timestamptz not null default NOW(),
        "updated_at" timestamptz not null default NOW(),
        constraint "ai_requests_pkey" primary key ("id")
      );
    `);

    // Add foreign key from ai_requests.user_id to users.id (set null on delete)
    this.addSql(
      `alter table "ai_requests"
       add constraint "ai_requests_user_id_foreign"
       foreign key ("user_id") references "users" ("id")
       on update cascade on delete set null;`,
    );

    // Indexes on ai_requests
    this.addSql(
      `create index "ai_requests_task_name_index" on "ai_requests" ("task_name");`,
    );
    this.addSql(
      `create index "ai_requests_status_index" on "ai_requests" ("status");`,
    );
    this.addSql(
      `create index "ai_requests_created_at_index" on "ai_requests" ("created_at");`,
    );

    // Create ai_request_attempts table
    this.addSql(`
      create table "ai_request_attempts" (
        "id" uuid not null default gen_random_uuid(),
        "ai_request_id" uuid not null,
        "attempt_number" integer not null,
        "provider_name" varchar(32) not null,
        "model" varchar(128) not null,
        "status" "ai_attempt_status_enum" not null,
        "error_code" "ai_attempt_error_code_enum",
        "error_message" text,
        "raw_response_text" text,
        "parsed_json" jsonb,
        "latency_ms" integer not null,
        "input_tokens" integer,
        "output_tokens" integer,
        "input_cost_usd" numeric(12, 6),
        "output_cost_usd" numeric(12, 6),
        "total_cost_usd" numeric(12, 6),
        "created_at" timestamptz not null default NOW(),
        constraint "ai_request_attempts_pkey" primary key ("id")
      );
    `);

    // Add foreign key from ai_request_attempts.ai_request_id to ai_requests.id (cascade on delete)
    this.addSql(
      `alter table "ai_request_attempts"
       add constraint "ai_request_attempts_ai_request_id_foreign"
       foreign key ("ai_request_id") references "ai_requests" ("id")
       on update cascade on delete cascade;`,
    );

    // Indexes on ai_request_attempts
    this.addSql(
      `create index "ai_request_attempts_ai_request_id_index" on "ai_request_attempts" ("ai_request_id");`,
    );
    this.addSql(
      `create index "ai_request_attempts_provider_name_index" on "ai_request_attempts" ("provider_name");`,
    );
  }

  override down(): void {
    // Drop indexes on ai_request_attempts
    this.addSql(
      `drop index if exists "ai_request_attempts_provider_name_index";`,
    );
    this.addSql(
      `drop index if exists "ai_request_attempts_ai_request_id_index";`,
    );

    // Drop ai_request_attempts table (FK is dropped implicitly)
    this.addSql(`drop table if exists "ai_request_attempts";`);

    // Drop indexes on ai_requests
    this.addSql(`drop index if exists "ai_requests_created_at_index";`);
    this.addSql(`drop index if exists "ai_requests_status_index";`);
    this.addSql(`drop index if exists "ai_requests_task_name_index";`);

    // Drop ai_requests table (FK is dropped implicitly)
    this.addSql(`drop table if exists "ai_requests";`);

    // Drop enum types
    this.addSql(`drop type if exists "ai_attempt_error_code_enum";`);
    this.addSql(`drop type if exists "ai_attempt_status_enum";`);
    this.addSql(`drop type if exists "ai_request_status_enum";`);
  }
}
