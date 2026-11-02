import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { MikroORM } from '@mikro-orm/core';
import config from '../src/mikro-orm.config';

async function checkMigrations() {
  // MikroORM loads entities and migrations with import(), which bypasses
  // ts-node's require hook; load them through require() like the CLI does
  // for CommonJS projects.
  const orm = await MikroORM.init({
    ...config,
    dynamicImportProvider: (id: string) =>
      Promise.resolve(createRequire(__filename)(fileURLToPath(id))),
  });
  const migrator = orm.migrator;

  try {
    const pendingMigrations = await migrator.getPending();

    if (pendingMigrations.length > 0) {
      console.error('❌ There are pending migrations that need to be applied:');
      pendingMigrations.forEach((migration) => {
        console.error(`  - ${migration.name}`);
      });
      console.error('\nPlease run: npm run migration:up');
      await orm.close();
      process.exit(1);
    } else {
      console.log('✅ All migrations are applied.');
      await orm.close();
      process.exit(0);
    }
  } catch (error) {
    console.error('❌ Error checking migrations:', error);
    await orm.close();
    process.exit(1);
  }
}

checkMigrations();
