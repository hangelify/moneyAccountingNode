import { knex } from '@mikro-orm/postgresql';

/** Empties every table but the migration log, in the test database. */
export async function truncateAll(): Promise<void> {
  const db = knex({
    client: 'pg',
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
  });
  try {
    const { rows } = await db.raw<{ rows: Array<{ tablename: string }> }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'`,
    );
    if (rows.length === 0) return;
    const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
    await db.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  } finally {
    await db.destroy();
  }
}
