import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

/** Works with both node-postgres (production) and PGlite (tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function connect(databaseUrl: string): Promise<{ db: Db; close: () => Promise<void> }> {
  // e2-micro has 1 GB RAM: keep the pool small.
  // A stuck query, lock or open transaction fails fast instead of freezing every request.
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    options: '-c lock_timeout=15000',
  });
  const db = drizzle(pool, { schema }) as unknown as Db;
  // Migrations may legitimately run longer than a request.
  const migrator = new pg.Client({ connectionString: databaseUrl });
  await migrator.connect();
  try {
    await migrate(drizzle(migrator), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await migrator.end();
  }
  return { db, close: () => pool.end() };
}

export { schema };
