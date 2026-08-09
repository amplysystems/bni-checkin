import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@/db/schema';

// Db is the shared PgDatabase base so both neon-http (prod) and PGlite (tests)
// satisfy it. IMPORTANT: .transaction() type-checks but THROWS at runtime on
// the neon-http driver — do not use it. Use single-statement upserts +
// DB constraints for atomicity (see uniq_active_attendance, getOrCreateMeetingFor).
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let override: Db | undefined;
let cached: Db | undefined;

export function setDb(db: unknown) {
  if (process.env.NODE_ENV === 'production') throw new Error('setDb is a test-only seam');
  override = db as Db;
}

export function getDb(): Db {
  if (override) return override;
  if (!cached) cached = drizzle(neon(process.env.DATABASE_URL!), { schema });
  return cached;
}
