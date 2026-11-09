import { Migration } from '@mikro-orm/migrations';

// A bill line's own category, so a line can have a category without a
// sub-category (HAN-47). Nullable: lines the AI could not place stay
// uncategorized. Lines with a sub-category get its category; soft-deleted
// sub-categories included, so old bills keep their category. Keeping the two
// in step on later writes is the bill service's job.
export class Migration20261109130000_AddBillLineCategory extends Migration {
  override up(): void {
    this.addSql(
      `alter table "bill_sub_categories" add column "category_id" uuid null;`,
    );
    this.addSql(
      `alter table "bill_sub_categories" add constraint "bill_sub_categories_category_id_foreign" foreign key ("category_id") references "categories" ("id") on update cascade on delete restrict;`,
    );
    this.addSql(
      `create index "bill_sub_categories_category_id_partial_index" on "bill_sub_categories" ("category_id") where "category_id" is not null;`,
    );
    this.addSql(`
      update bill_sub_categories bsc
      set    category_id = sc.category_id
      from   sub_categories sc
      where  sc.id = bsc.sub_category_id;
    `);
  }

  override down(): void {
    // Nothing is lost: until lines can carry a category alone, it is the
    // sub-category's.
    this.addSql(
      `drop index if exists "bill_sub_categories_category_id_partial_index";`,
    );
    this.addSql(
      `alter table "bill_sub_categories" drop constraint if exists "bill_sub_categories_category_id_foreign";`,
    );
    this.addSql(
      `alter table "bill_sub_categories" drop column if exists "category_id";`,
    );
  }
}
