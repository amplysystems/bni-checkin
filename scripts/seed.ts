import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { people, personRoles, memberships, settings } from '../db/schema';

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

export async function seed(db: any) {
  for (const [fullName, industry, company] of MEMBERS) {
    const existing = await db.select().from(people).where(eq(people.fullName, fullName));
    if (existing.length > 0) continue;
    const [p] = await db.insert(people).values({ fullName, industry, company }).returning();
    await db.insert(memberships).values({ personId: p.id, status: 'member' });
  }
  for (const [fullName, title] of LEADERSHIP) {
    const existing = await db.select().from(people).where(eq(people.fullName, fullName));
    if (existing.length > 0) continue;
    const [p] = await db.insert(people).values({ fullName, notes: title }).returning();
    await db.insert(personRoles).values({ personId: p.id, role: 'leadership' });
  }
  await db.insert(settings)
    .values({ id: 1, openSeats: ['Electrician', 'HVAC', 'IT services', 'Dentist'] })
    .onConflictDoNothing();
}

async function main() {
  const db = drizzle(neon(process.env.DATABASE_URL!), { schema });
  await seed(db);
  console.log('Seed complete');
}
if (process.argv[1]?.includes('seed')) main();
