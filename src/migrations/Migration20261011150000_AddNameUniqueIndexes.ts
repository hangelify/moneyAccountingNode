import { Migration } from '@mikro-orm/migrations';

// Names are unique case-insensitively among live rows: categories per
// household, sub-categories per category, budgets per household and active
// planning horizons per budget.
export class Migration20261011150000_AddNameUniqueIndexes extends Migration {
  override up(): void {
    // Existing duplicates are user data: stop and resolve them by hand first
    // rather than renaming anything silently.
    this.addSql(`
      do $$
      declare
        dups text;
      begin
        select string_agg(d, '; ') into dups from (
          select 'categories ' || household_id || ': ' || lower("name") as d
            from "categories" where "deleted_at" is null
            group by household_id, lower("name") having count(*) > 1
          union all
          select 'sub_categories ' || category_id || ': ' || lower("name")
            from "sub_categories" where "deleted_at" is null
            group by category_id, lower("name") having count(*) > 1
          union all
          select 'budgets ' || household_id || ': ' || lower("name")
            from "budgets" where "deleted_at" is null
            group by household_id, lower("name") having count(*) > 1
          union all
          select 'planing_horizons ' || budget_id || ': ' || lower("name")
            from "planing_horizons"
            where "deleted_at" is null and not "is_archived"
            group by budget_id, lower("name") having count(*) > 1
        ) x;
        if dups is not null then
          raise exception 'case-insensitive duplicate names: %', dups;
        end if;
      end $$;
    `);

    this.addSql(
      `create unique index "categories_household_id_name_lower_unique" on "categories" ("household_id", lower("name")) where "deleted_at" is null;`,
    );
    this.addSql(
      `create unique index "sub_categories_category_id_name_lower_unique" on "sub_categories" ("category_id", lower("name")) where "deleted_at" is null;`,
    );
    this.addSql(`drop index if exists "budgets_household_id_name_unique";`);
    this.addSql(
      `create unique index "budgets_household_id_name_lower_unique" on "budgets" ("household_id", lower("name")) where "deleted_at" is null;`,
    );
    this.addSql(
      `create unique index "planing_horizons_budget_id_name_lower_unique" on "planing_horizons" ("budget_id", lower("name")) where "deleted_at" is null and not "is_archived";`,
    );
  }

  override down(): void {
    this.addSql(
      `drop index if exists "planing_horizons_budget_id_name_lower_unique";`,
    );
    this.addSql(
      `drop index if exists "budgets_household_id_name_lower_unique";`,
    );
    this.addSql(
      `create unique index "budgets_household_id_name_unique" on "budgets" ("household_id", "name") where "deleted_at" is null;`,
    );
    this.addSql(
      `drop index if exists "sub_categories_category_id_name_lower_unique";`,
    );
    this.addSql(
      `drop index if exists "categories_household_id_name_lower_unique";`,
    );
  }
}
