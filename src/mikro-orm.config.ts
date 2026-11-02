import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { SeedManager } from '@mikro-orm/seeder';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

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
    // v7 changed both defaults; keep the v6 behaviour the entities and the
    // existing data were written against (reflected property types, dates
    // read and written in the server's local timezone).
    metadataProvider: ReflectMetadataProvider,
    forceUtcTimezone: false,
    // v6 inferred `on update cascade` for every ManyToOne and the migrations
    // created the FKs that way; v7 no longer infers it.
    schemaGenerator: { defaultUpdateRule: 'cascade' },
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
