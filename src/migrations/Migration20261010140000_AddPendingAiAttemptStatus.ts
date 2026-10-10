import { Migration } from '@mikro-orm/migrations';

export class Migration20261010140000_AddPendingAiAttemptStatus extends Migration {
  override up(): void {
    // An attempt is PENDING while its provider call runs, so a crash no longer
    // leaves a fake SUCCESS behind. ADD VALUE is allowed inside the migration
    // transaction (PG 12+); the value just cannot be used before it commits,
    // and nothing here does. Pending migrations run in one transaction, so a
    // later migration must not use 'PENDING' in the same `migration:up` run.
    this.addSql(
      `alter type "ai_attempt_status_enum" add value if not exists 'PENDING' before 'SUCCESS';`,
    );
  }

  override down(): void {
    // Postgres cannot drop an enum value: rebuild the type without it and
    // fail the attempts that were still in flight.
    this.addSql(
      `alter type "ai_attempt_status_enum" rename to "ai_attempt_status_enum_old";`,
    );
    this.addSql(
      `create type "ai_attempt_status_enum" as enum ('SUCCESS', 'FAILED');`,
    );
    this.addSql(
      `alter table "ai_request_attempts" alter column "status" type "ai_attempt_status_enum"
       using (case when "status"::text = 'PENDING' then 'FAILED' else "status"::text end)::"ai_attempt_status_enum";`,
    );
    this.addSql(`drop type "ai_attempt_status_enum_old";`);
  }
}
