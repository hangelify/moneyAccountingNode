import { Client } from 'pg';

/** Empties every table but the migration log, in the test database. */
export async function truncateAll(): Promise<void> {
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await db.connect();
  try {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'`,
    );
    if (rows.length === 0) return;
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    await db.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  } finally {
    await db.end();
  }
}
