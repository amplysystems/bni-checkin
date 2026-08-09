import { and, eq, isNull, ilike, sql } from 'drizzle-orm';
import { memberships, people } from '@/db/schema';
import type { Db } from '@/lib/db';
import { checkIn } from '@/lib/checkins';

export type VisitorInput = {
  fullName: string; industry: string | null; company: string | null;
  email: string; phone: string | null; clientOpId: string; now?: Date;
};

const publicFields = {
  id: people.id, fullName: people.fullName, industry: people.industry, company: people.company,
};

export async function suggestMatches(db: Db, q: { email: string; fullName: string }) {
  const normEmail = q.email.trim().toLowerCase();
  const normName = q.fullName.trim().toLowerCase();
  return db.select(publicFields).from(people).where(and(
    isNull(people.deactivatedAt),
    sql`(lower(${people.email}) = ${normEmail} OR lower(${people.fullName}) = ${normName})`,
  ));
}

export async function registerVisitor(db: Db, input: VisitorInput) {
  const [person] = await db.insert(people).values({
    fullName: input.fullName.trim(),
    industry: input.industry, company: input.company,
    email: input.email.trim(), phone: input.phone,
  }).returning();
  await db.insert(memberships).values({ personId: person.id, status: 'visitor' });
  const result = await checkIn(db, {
    personId: person.id, clientOpId: input.clientOpId, source: 'kiosk', now: input.now,
  });
  return { person, ...result };
}

export async function returningSearch(db: Db, query: string) {
  const q = `%${query.trim()}%`;
  return db.select(publicFields).from(people)
    .innerJoin(memberships, and(
      eq(memberships.personId, people.id),
      eq(memberships.status, 'visitor'),
      isNull(memberships.endedAt),
    ))
    .where(and(isNull(people.deactivatedAt), ilike(people.fullName, q)))
    .limit(8);
}
