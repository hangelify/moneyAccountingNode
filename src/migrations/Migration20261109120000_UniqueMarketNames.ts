import { Migration } from '@mikro-orm/migrations';

export class Migration20261109120000_UniqueMarketNames extends Migration {
  override up(): void {
    // A household's live markets whose names differ only in case are one
    // market: the bills move to the oldest one and the rest are soft deleted,
    // so the unique index below can be built.
    this.addSql(`
      with ranked as (
        select id,
               first_value(id) over (
                 partition by household_id, lower(name)
                 order by created_at, id
               ) as keeper
        from   markets
        where  deleted_at is null
      ),
      dups as (
        select id, keeper from ranked where id <> keeper
      ),
      moved as (
        update bills b
        set    market_id = d.keeper
        from   dups d
        where  b.market_id = d.id
      )
      update markets m
      set    deleted_at = now(), updated_at = now()
      from   dups d
      where  m.id = d.id;
    `);
    this.addSql(
      `create unique index "markets_household_id_lower_name_unique" on "markets" ("household_id", lower("name")) where "deleted_at" is null;`,
    );
  }

  override down(): void {
    // The merged duplicates stay merged: which bills were moved is not kept.
    this.addSql(
      `drop index if exists "markets_household_id_lower_name_unique";`,
    );
  }
}
