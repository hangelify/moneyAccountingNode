import { Migration } from '@mikro-orm/migrations';

export class Migration20261031180000_AddHouseholdCurrency extends Migration {
  override up(): void {
    // No default: new households always set it. Existing ones take the
    // creator's currency.
    this.addSql(
      `alter table "households" add column "currency" "currency_enum" null;`,
    );
    this.addSql(`
      update "households" h set "currency" = u."currency"
      from "users" u where u."id" = h."created_by";
    `);
    this.addSql(
      `alter table "households" alter column "currency" set not null;`,
    );
  }

  override down(): void {
    this.addSql(`alter table "households" drop column "currency";`);
  }
}
