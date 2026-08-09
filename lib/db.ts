import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@/db/schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let override: Db | undefined;
let cached: Db | undefined;

export function setDb(db: unknown) { override = db as Db; }

export function getDb(): Db {
  if (override) return override;
  if (!cached) cached = drizzle(neon(process.env.DATABASE_URL!), { schema });
  return cached;
}
