import { Migration } from '@mikro-orm/migrations';

export class Migration20261011160000_DedupePersonalHouseholds extends Migration {
  override up(): void {
    // Migration20260603130000 created a second "Personal" household for users
    // who already had one from registration and moved their rows into it.
    // Delete only empty duplicates: the owner is the sole member, and there are
    // no bills, budgets, categories, markets or invites (soft-deleted rows
    // count). If every duplicate is empty, the oldest one is kept. Owners with
    // data in more than one "Personal" household are reported, not merged;
    // scripts/diagnostics/p20-duplicate-personal-households.sql lists them too.
    //
    // Candidates are the live "Personal" households created no later than that
    // migration ran, so households users made afterwards are never touched.
    // Soft-deleted users are included: only their empty duplicates go.
    this.addSql(`
      do $$
      declare
        cutoff timestamptz;
        conflicts text;
      begin
        select executed_at into cutoff
        from mikro_orm_migrations
        where name like 'Migration20260603130000%';

        -- Rows inserted into a household take a key-share lock on it, so this
        -- keeps the emptiness check below valid until the delete commits.
        perform 1 from households h
        where h.name = 'Personal' and h.deleted_at is null and h.created_at <= cutoff
        for update;

        drop table if exists p20_personal;
        create temporary table p20_personal on commit drop as
        select
          h.id,
          hm.user_id as owner_id,
          h.created_at,
          not exists (select 1 from bills b             where b.household_id = h.id)
          and not exists (select 1 from budgets b       where b.household_id = h.id)
          and not exists (select 1 from categories c    where c.household_id = h.id)
          and not exists (select 1 from markets m       where m.household_id = h.id)
          and not exists (select 1 from household_invites i where i.household_id = h.id)
          and not exists (
            select 1 from household_members o
            where o.household_id = h.id and o.user_id <> hm.user_id
          ) as is_empty
        from households h
        join household_members hm
          on hm.household_id = h.id and hm.role = 'owner' and hm.user_id = h.created_by
        where h.name = 'Personal' and h.deleted_at is null and h.created_at <= cutoff;

        delete from households h
        using (
          select
            id,
            is_empty,
            row_number() over (
              partition by owner_id
              order by is_empty, created_at, id
            ) as rank
          from p20_personal
        ) p
        where h.id = p.id and p.is_empty and p.rank > 1;

        select string_agg(owner_id || ': ' || ids, '; ') into conflicts from (
          select owner_id, string_agg(id::text, ', ' order by created_at) as ids
          from p20_personal
          where not is_empty
          group by owner_id
          having count(*) > 1
        ) c;
        if conflicts is not null then
          raise notice 'owners with data in several Personal households, resolve by hand: %', conflicts;
        end if;
      end $$;
    `);
  }

  override down(): void {
    // Deleted households were empty; there is nothing to restore.
  }
}
