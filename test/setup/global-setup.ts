import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { applyTestEnv } from './test-env';

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

// Recreates the test database from the migrations, so every run starts from
// the same empty schema and never touches the dev database.
//
// Jest runs specs in this same process (maxWorkers: 1), so nothing here may
// load MikroORM or reflect-metadata: their global state would leak into the
// specs' realms. Hence plain pg, and the migrations in a child process.
export default async function globalSetup(): Promise<void> {
  applyTestEnv();
  const dbName = process.env.DB_NAME!;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg') as {
    Client: new (config: object) => PgClient;
  };
  const admin = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  try {
    execFileSync('npx', ['mikro-orm', 'migration:up'], {
      // The config's paths are relative to the repository root.
      cwd: resolve(__dirname, '../..'),
      // No .snapshot-accounting_e2e.json next to the real migrations.
      env: { ...process.env, MIKRO_ORM_MIGRATIONS_SNAPSHOT: 'false' },
      stdio: 'pipe',
    });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    console.error(String(stdout ?? ''), String(stderr ?? ''));
    throw err;
  }
}
