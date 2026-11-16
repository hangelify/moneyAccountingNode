import { Migration } from '@mikro-orm/migrations';

// A member's own name for a household (HAN-22); null shows the original
// name the owner set. text, not varchar(255): widening it later needs no
// table rewrite; UpdateMyHouseholdDto keeps it to 1-255 characters. A
// nullable column without a default is added without a table scan.
export class Migration20261116100000_AddHouseholdMemberDisplayName extends Migration {
  override up(): void {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`set local statement_timeout = '60s';`);
    this.addSql(
      `alter table "household_members" add column "display_name" text null;`,
    );
  }

  override down(): void {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`set local statement_timeout = '60s';`);
    this.addSql(`alter table "household_members" drop column "display_name";`);
  }
}
