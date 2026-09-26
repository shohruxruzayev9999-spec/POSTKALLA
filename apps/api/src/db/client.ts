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
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
  return { db, close: () => pool.end() };
}

export { schema };
