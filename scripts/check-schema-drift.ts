/**
 * Schema drift check (HAN-10), run in CI after `migration:fresh`:
 *
 * 1. Entities vs the migrated database: the SQL schema:update would run must
 *    be empty. Otherwise an entity describes a column, index or foreign key
 *    the migrations never created (or the other way round).
 * 2. Entities vs src/migrations/.snapshot-accounting.json: the next
 *    `migration:create` must start from a clean diff, not drag in old drift.
 *
 * Fix either by changing the entity to match the database, or by adding a
 * migration (`npm run migration:create`) when the entity is the intent.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { MikroORM } from '@mikro-orm/core';
import config from '../src/mikro-orm.config';

async function main(): Promise<void> {
  // Load entities through require() like the CLI does for CommonJS projects
  // (see scripts/check-migrations.ts).
  const orm = await MikroORM.init({
    ...config,
    dynamicImportProvider: (id: string) =>
      Promise.resolve(createRequire(__filename)(fileURLToPath(id))),
  });
  let failed = false;
  try {
    const sql = (await orm.schema.getUpdateSchemaSQL({ wrap: false })).trim();
    if (sql.length > 0) {
      failed = true;
      console.error(
        'Entities differ from the migrated database. schema:update would run:\n\n' +
          sql +
          '\n\nMake the entities match the migrations, or add a migration.',
      );
    }
    if (await orm.migrator.checkSchema()) {
      failed = true;
      console.error(
        'Entities differ from src/migrations/.snapshot-accounting.json: ' +
          'run `npx mikro-orm migration:create --dump` to see the diff.',
      );
    }
  } finally {
    await orm.close();
  }
  if (failed) process.exit(1);
  console.log('Entities, snapshot and migrated database agree.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
