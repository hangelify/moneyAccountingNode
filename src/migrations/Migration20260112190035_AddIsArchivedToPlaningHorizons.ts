import { Migration } from '@mikro-orm/migrations';

export class Migration20260112190035_AddIsArchivedToPlaningHorizons extends Migration {
  override up(): void {
    // Add is_archived column to planing_horizons table
    this.addSql(`
      alter table "planing_horizons" 
      add column "is_archived" boolean not null default false;
    `);
  }

  override down(): void {
    this.addSql(
      `alter table "planing_horizons" drop column if exists "is_archived";`,
    );
  }
}
