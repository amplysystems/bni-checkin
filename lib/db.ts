import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '@/db/schema';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let override: Db | undefined;
let cached: Db | undefined;

export function setDb(db: unknown) { override = db as Db; }

export function getDb(): Db {
  if (override) return override;
  if (!cached) cached = drizzle(neon(process.env.DATABASE_URL!), { schema });
  return cached;
}
