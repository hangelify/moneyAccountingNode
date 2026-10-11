import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { SeedManager } from '@mikro-orm/seeder';

// Single ORM config for the app (AppModule), the MikroORM CLI and scripts/.
// Env is read on each call so AppModule resolves it at bootstrap, not import.
// Compiled entities live under dist/ as laid out by tsconfig.build.json
// (rootDir ./src), e.g. dist/entities/user.entity.js.
export function createMikroOrmConfig() {
  return defineConfig({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    dbName: process.env.DB_NAME || 'accounting',
    entities: ['./dist/**/*.entity.js'],
    entitiesTs: ['./src/**/*.entity.ts'],
    migrations: {
      path: './dist/migrations',
      pathTs: './src/migrations',
      glob: '!(*.d).{js,ts}',
    },
    seeder: {
      path: './src/seeders',
      pathTs: './src/seeders',
      glob: '!(*.d).{js,ts}',
      defaultSeeder: 'DatabaseSeeder',
    },
    extensions: [Migrator, SeedManager],
  });
}

// Default export is what the MikroORM CLI and scripts/ load.
export default createMikroOrmConfig();
