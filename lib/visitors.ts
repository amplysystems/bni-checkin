import { and, eq, isNull, ilike, or, sql, type SQL } from 'drizzle-orm';
import { attendance, memberships, people } from '@/db/schema';
import type { Db } from '@/lib/db';
import { checkIn } from '@/lib/checkins';

export type VisitorInput = {
  fullName: string; industry: string | null; company: string | null;
  email: string; phone: string | null; clientOpId: string; now?: Date;
};

const publicFields = {
  id: people.id, fullName: people.fullName, industry: people.industry, company: people.company,
};

// Empty-after-trim collapses to null so we never persist '' as a value.
function trimOrNull(s: string | null): string | null {
  if (s === null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

export async function suggestMatches(db: Db, q: { email: string; fullName: string }) {
  const normEmail = q.email.trim().toLowerCase();
  const normName = q.fullName.trim().toLowerCase();
  if (!normEmail && !normName) return [];

  const clauses: SQL[] = [];
  if (normEmail) clauses.push(sql`lower(${people.email}) = ${normEmail}`);
  if (normName) clauses.push(sql`lower(${people.fullName}) = ${normName}`);

  return db.select(publicFields).from(people).where(and(
    isNull(people.deactivatedAt),
    or(...clauses),
  )).limit(8);
}

export async function registerVisitor(db: Db, input: VisitorInput) {
  // Idempotent on clientOpId: a kiosk retry must not create a second
  // person/membership. Check for a prior attendance row up front, before any
  // inserts — checkIn()'s own dedupe runs too late for that (it would still
  // let a duplicate person/membership slip in ahead of it).
  const replayed = await db.select().from(attendance).where(eq(attendance.clientOpId, input.clientOpId));
  if (replayed[0]) {
    const [person] = await db.select().from(people).where(eq(people.id, replayed[0].personId));
    return { person, attendance: replayed[0], deduped: true, voided: replayed[0].voidedAt !== null };
  }

  const [person] = await db.insert(people).values({
    fullName: input.fullName.trim(),
    industry: input.industry === null ? null : input.industry.trim(),
    company: trimOrNull(input.company),
    email: input.email.trim(),
    phone: trimOrNull(input.phone),
  }).returning();
  await db.insert(memberships).values({ personId: person.id, status: 'visitor' });
  const result = await checkIn(db, {
    personId: person.id, clientOpId: input.clientOpId, source: 'kiosk', now: input.now,
  });
  return { person, ...result };
}

// Escapes LIKE/ILIKE metacharacters (Postgres' default escape char is `\`)
// so user-typed %, _, and \ are matched literally rather than as wildcards.
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export async function returningSearch(db: Db, query: string) {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const q = `%${escapeLike(trimmed)}%`;
  return db.select(publicFields).from(people)
    .innerJoin(memberships, and(
      eq(memberships.personId, people.id),
      eq(memberships.status, 'visitor'),
      isNull(memberships.endedAt),
    ))
    .where(and(isNull(people.deactivatedAt), ilike(people.fullName, q)))
    .limit(8);
}
