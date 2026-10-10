import { Migration } from '@mikro-orm/migrations';

export class Migration20261010150000_AddTruncatedAiAttemptErrorCode extends Migration {
  override up(): void {
    // An answer cut off at the output token limit is TRUNCATED instead of
    // looking like a malformed body. ADD VALUE is allowed inside the migration
    // transaction (PG 12+); the value just cannot be used before it commits,
    // and nothing here does. Pending migrations run in one transaction, so a
    // later migration must not use 'TRUNCATED' in the same `migration:up` run.
    this.addSql(
      `alter type "ai_attempt_error_code_enum" add value if not exists 'TRUNCATED' before 'PROVIDER_ERROR';`,
    );
  }

  override down(): void {
    // Postgres cannot drop an enum value: rebuild the type without it and
    // record truncated attempts as INVALID_RESPONSE, as they were before.
    this.addSql(
      `alter type "ai_attempt_error_code_enum" rename to "ai_attempt_error_code_enum_old";`,
    );
    this.addSql(
      `create type "ai_attempt_error_code_enum" as enum ('TIMEOUT', 'RATE_LIMIT', 'SERVER_ERROR', 'SCHEMA_INVALID', 'INVALID_RESPONSE', 'PROVIDER_ERROR', 'UNKNOWN');`,
    );
    this.addSql(
      `alter table "ai_request_attempts" alter column "error_code" type "ai_attempt_error_code_enum"
       using (case when "error_code"::text = 'TRUNCATED' then 'INVALID_RESPONSE' else "error_code"::text end)::"ai_attempt_error_code_enum";`,
    );
    this.addSql(`drop type "ai_attempt_error_code_enum_old";`);
  }
}
