import { Migration } from '@mikro-orm/migrations';

export class Migration20261011120000_AddRefreshTokenRevokedAt extends Migration {
  override up(): void {
    // When a token was revoked, for the refresh reuse grace window. Tokens
    // revoked before this column existed stay null: outside any window.
    this.addSql(
      `alter table "refresh_tokens" add column "revoked_at" timestamptz null;`,
    );
  }

  override down(): void {
    this.addSql(`alter table "refresh_tokens" drop column "revoked_at";`);
  }
}
