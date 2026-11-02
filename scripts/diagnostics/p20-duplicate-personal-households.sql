-- P20 diagnostic: users who own more than one "Personal" household.
--
-- Migration20260603130000_MigrateOwnershipToHouseholds created a new
-- "Personal" household for every user, even when registration had already
-- created one, and moved the user's rows into the new one. This lists every
-- "Personal" household of such owners with its row counts, so the empty
-- duplicates can be told apart from households that hold data.
--
-- Read-only. Run with: psql "$DATABASE_URL" -f p20-duplicate-personal-households.sql
-- Counts include soft-deleted rows: a soft-deleted bill is still data.
-- Soft-deleted households are listed too; Migration20261011160000 skips them.

with personal as (
  select h.id, h.created_by, h.created_at, h.deleted_at, hm.user_id as owner_id
  from households h
  join household_members hm
    on hm.household_id = h.id and hm.role = 'owner' and hm.user_id = h.created_by
  where h.name = 'Personal'
),
dup_owners as (
  select owner_id from personal group by owner_id having count(*) > 1
)
select
  p.owner_id,
  u.email,
  u.deleted_at                                                          as user_deleted_at,
  p.id                                                                  as household_id,
  p.created_at,
  p.deleted_at                                                          as household_deleted_at,
  (select count(*) from bills b             where b.household_id = p.id) as bills,
  (select count(*) from budgets b           where b.household_id = p.id) as budgets,
  (select count(*) from categories c        where c.household_id = p.id) as categories,
  (select count(*) from markets m           where m.household_id = p.id) as markets,
  (select count(*) from household_members m where m.household_id = p.id) as members,
  (select count(*) from household_invites i where i.household_id = p.id) as invites
from personal p
join dup_owners d on d.owner_id = p.owner_id
join users u on u.id = p.owner_id
order by p.owner_id, p.created_at;
