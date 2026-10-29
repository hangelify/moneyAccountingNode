import { Migration } from '@mikro-orm/migrations';

export class Migration20261012130000_BillItemsOnePerLine extends Migration {
  override up(): void {
    // One row per receipt line: two lines of one sub-category (tomatoes and
    // cucumbers as "Vegetables") no longer have to be merged into one row
    // that keeps only the first line's name, weight and unit price.
    // bill_sub_categories_bill_id_index and
    // bill_sub_categories_sub_category_id_partial_index still serve the
    // lookups and joins this index was used for.
    this.addSql(
      `drop index if exists "bill_sub_categories_bill_sub_category_unique";`,
    );
  }

  override down(): void {
    // Merge the lines of one sub-category into the row with the lowest id,
    // the way drafts were saved before: amounts and counts add up, the
    // weight adds up only when every line is weighed in one unit, and the
    // unit price no longer describes the merged row.
    this.addSql(`
      with g as (
        select min(id::text)::uuid as keep_id,
               sum(amount) as amount,
               sum(product_count) as product_count,
               case
                 when count(product_weight) = count(*)
                  and count(distinct coalesce(unit, '')) = 1
                 then sum(product_weight)
               end as product_weight
        from "bill_sub_categories"
        where sub_category_id is not null
        group by bill_id, sub_category_id
        having count(*) > 1
      )
      update "bill_sub_categories" b
        set amount = g.amount,
            product_count = g.product_count,
            product_weight = g.product_weight,
            price_per_unit = null
        from g
        where b.id = g.keep_id;
    `);
    this.addSql(`
      delete from "bill_sub_categories" b
        using "bill_sub_categories" k
        where k.bill_id = b.bill_id
          and k.sub_category_id = b.sub_category_id
          and k.id::text < b.id::text;
    `);
    this.addSql(`
      create unique index "bill_sub_categories_bill_sub_category_unique"
        on "bill_sub_categories" ("bill_id", "sub_category_id")
        where sub_category_id is not null;
    `);
  }
}
