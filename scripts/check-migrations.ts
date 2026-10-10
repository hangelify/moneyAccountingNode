import { MikroORM } from '@mikro-orm/core';
import config from '../src/mikro-orm.config';

async function checkMigrations() {
  const orm = await MikroORM.init(config);
  const migrator = orm.getMigrator();

  try {
    const pendingMigrations = await migrator.getPendingMigrations();

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
