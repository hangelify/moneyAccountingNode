import { Migration } from '@mikro-orm/migrations';

export class Migration20261101120000_AddDuplicateBillStatus extends Migration {
  override up(): void {
    // Alone in its own migration: PostgreSQL cannot use an enum value in the
    // transaction that adds it, and the next migration builds on this value.
    this.addSql(
      `alter type "bill_status_enum" add value if not exists 'duplicate';`,
    );
  }

  override down(): void {
    // PostgreSQL cannot drop a value from an enum type, so this is a no-op.
    // The value stays unused once the next migration is rolled back.
  }
}
