import { Migration } from '@mikro-orm/migrations';

export class Migration20251230121421_UpdateSessionTokenLength extends Migration {
  override up(): void {
    this.addSql(
      `alter table "sessions" alter column "session_token" type varchar(500) using "session_token"::varchar(500);`,
    );
  }

  override down(): void {
    this.addSql(
      `alter table "sessions" alter column "session_token" type varchar(255) using "session_token"::varchar(255);`,
    );
  }
}
