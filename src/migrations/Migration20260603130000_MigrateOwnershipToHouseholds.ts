import { Migration } from '@mikro-orm/migrations';

export class Migration20260603130000_MigrateOwnershipToHouseholds extends Migration {
  override up(): void {
    // Step 1: add household_id columns (nullable initially)
    this.addSql(
      `alter table "bills"      add column "household_id" uuid null;`,
    );
    this.addSql(
      `alter table "bills"      add column "created_by_user_id" uuid null;`,
    );
    this.addSql(
      `alter table "budgets"    add column "household_id" uuid null;`,
    );
    this.addSql(
      `alter table "categories" add column "household_id" uuid null;`,
    );
    this.addSql(
      `alter table "markets"    add column "household_id" uuid null;`,
    );

    // Step 2: for each existing user, create a personal household and re-point their rows
    this.addSql(`
      do $$
      declare
        u record;
        hid uuid;
      begin
        for u in select id from users loop
          -- create personal household (only if one doesn't already exist from Phase A registration)
          insert into households (name, created_by, created_at)
          values ('Personal', u.id, now())
          on conflict do nothing
          returning id into hid;

          -- if household already existed (from Phase A), look it up
          if hid is null then
            select h.id into hid
            from households h
            join household_members hm on hm.household_id = h.id
            where hm.user_id = u.id and hm.role = 'owner' and h.name = 'Personal'
            limit 1;
          end if;

          -- owner membership (idempotent)
          insert into household_members (household_id, user_id, role, joined_at)
          values (hid, u.id, 'owner', now())
          on conflict do nothing;

          -- re-point data rows
          update bills      set household_id = hid, created_by_user_id = user_id where user_id = u.id;
          update budgets    set household_id = hid where user_id = u.id;
          update categories set household_id = hid where user_id = u.id;
          update markets    set household_id = hid where user_id = u.id;
        end loop;
      end $$;
    `);

    // Step 3: enforce NOT NULL now that all rows are filled
    this.addSql(
      `alter table "bills"      alter column "household_id" set not null;`,
    );
    this.addSql(
      `alter table "budgets"    alter column "household_id" set not null;`,
    );
    this.addSql(
      `alter table "categories" alter column "household_id" set not null;`,
    );
    this.addSql(
      `alter table "markets"    alter column "household_id" set not null;`,
    );

    // Step 4: add foreign keys
    this.addSql(`
      alter table "bills" add constraint "bills_household_id_fkey"
        foreign key ("household_id") references "households"("id") on delete cascade;
      alter table "bills" add constraint "bills_created_by_user_id_fkey"
        foreign key ("created_by_user_id") references "users"("id") on delete set null;
      alter table "budgets" add constraint "budgets_household_id_fkey"
        foreign key ("household_id") references "households"("id") on delete cascade;
      alter table "categories" add constraint "categories_household_id_fkey"
        foreign key ("household_id") references "households"("id") on delete cascade;
      alter table "markets" add constraint "markets_household_id_fkey"
        foreign key ("household_id") references "households"("id") on delete cascade;
    `);

    // Step 5: drop old unique indices and recreate for budgets
    this.addSql(`drop index if exists "budgets_user_id_name_unique";`);
    this.addSql(`
      create unique index "budgets_household_id_name_unique"
        on "budgets" ("household_id", "name") where "deleted_at" is null;
    `);

    // Step 6: drop old user_id columns
    this.addSql(`alter table "bills"      drop column "user_id";`);
    this.addSql(`alter table "budgets"    drop column "user_id";`);
    this.addSql(`alter table "categories" drop column "user_id";`);
    this.addSql(`alter table "markets"    drop column "user_id";`);
  }

  override down(): void {
    throw new Error(
      'Migration20260603130000_MigrateOwnershipToHouseholds is irreversible. ' +
        'Cannot restore user_id columns after household migration.',
    );
  }
}
