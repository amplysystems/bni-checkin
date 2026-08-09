// Bootstrap seed for the initial chapter roster. Safe to re-run to heal a
// partially failed run. Do NOT re-run after go-live roster edits: the
// idempotency key is fullName, so a renamed person (e.g. 'Gio' → real name)
// would be re-created under the old name.

import { existsSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import { people, personRoles, memberships, settings } from '../db/schema';
import type { TestDb } from '../tests/helpers/db';

const MEMBERS: Array<[string, string, string | null]> = [
  ['Jason Barrios', 'Marketing', 'Amply Systems'],
  ['Mike Anderson', 'Divorce attorney', null],
  ['Paul Manelis', 'Wealth management', null],
  ['Stephanie Oh', 'Realtor', null],
  ['Michael Trayvas', 'Plumbing', null],
  ['Gio', 'Restoration', 'IGK'],
  ['Larry Toban', 'Flooring', 'Floor Coverings International'],
  ['Anthony Gillette', 'P&C insurance', 'State Farm'],
  ['Anthony Galizia', 'Business consulting', null],
  ['Paul Kramer', 'Mortgage broker', null],
];
const LEADERSHIP: Array<[string, string]> = [
  ['Carey Rothbardt', 'Launch Coach'],
  ['Marisa', 'Area Director'],
];

export async function seed(db: NeonHttpDatabase<typeof schema> | TestDb) {
  for (const [fullName, industry, company] of MEMBERS) {
    let [p] = await db.select().from(people).where(eq(people.fullName, fullName));
    if (!p) {
      [p] = await db.insert(people).values({ fullName, industry, company }).returning();
    }
    const openMembership = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.personId, p.id), isNull(memberships.endedAt)));
    if (openMembership.length === 0) {
      await db.insert(memberships).values({ personId: p.id, status: 'member' });
    }
  }
  for (const [fullName, title] of LEADERSHIP) {
    let [p] = await db.select().from(people).where(eq(people.fullName, fullName));
    if (!p) {
      [p] = await db.insert(people).values({ fullName, notes: title }).returning();
    }
    await db.insert(personRoles).values({ personId: p.id, role: 'leadership' }).onConflictDoNothing();
  }
  await db.insert(settings)
    .values({ id: 1, openSeats: ['Electrician', 'HVAC', 'IT services', 'Dentist'] })
    .onConflictDoNothing();
}

async function main() {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const db = drizzle(neon(process.env.DATABASE_URL!), { schema });
  await seed(db);
  console.log('Seed complete');
}
if (require.main === module) main();
