import { Migration } from '@mikro-orm/migrations';

/** Bills read by the AI parser came from a photo; the rest were typed in. */
export const BACKFILL_BILL_SOURCE = `
  update bills
  set    source = case when ai_request_id is not null
                       then 'photo' else 'manual' end::bill_source;
`;

// Where each bill came from (HAN-65): a photo, a hand entry or, later, a bank
// import. Defaults to manual, as a bill typed in by hand is; the app's writers
// always name the source.
export class Migration20261109140000_AddBillSource extends Migration {
  override up(): void {
    this.addSql(
      `create type "bill_source" as enum ('photo', 'manual', 'bank');`,
    );
    this.addSql(`alter table "bills" add column "source" "bill_source" null;`);
    this.addSql(BACKFILL_BILL_SOURCE);
    this.addSql(
      `alter table "bills" alter column "source" set default 'manual', alter column "source" set not null;`,
    );
  }

  override down(): void {
    this.addSql(`alter table "bills" drop column "source";`);
    this.addSql(`drop type "bill_source";`);
  }
}
