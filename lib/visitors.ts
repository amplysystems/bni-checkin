import { and, eq, isNull, ilike, or, sql, type SQL } from 'drizzle-orm';
import { attendance, memberships, people } from '@/db/schema';
import type { Db } from '@/lib/db';
import { checkIn, isUniqueViolation, CheckInError } from '@/lib/checkins';

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

// Deletes a losing race attempt's person+membership row. Logs and rethrows
// on failure rather than swallowing it — a failed cleanup leaves an orphan,
// but silently returning success would hide that from the caller.
async function deleteOrphan(db: Db, personId: string) {
  try {
    await db.delete(memberships).where(eq(memberships.personId, personId));
    await db.delete(people).where(eq(people.id, personId));
  } catch (cleanupErr) {
    console.error('registerVisitor: failed to delete orphan person/membership', { personId, cleanupErr });
    throw cleanupErr;
  }
}

function isOpRaceLoss(err: unknown): boolean {
  return isUniqueViolation(err) || (err instanceof CheckInError && err.code === 'op_conflict');
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

  // The pre-check above is safe against sequential retries but not against
  // two truly concurrent calls sharing a clientOpId: both can pass it before
  // either has inserted anything. Each then creates its own person+membership
  // and races checkIn() on attendance.client_op_id's unique constraint. Two
  // interleavings are possible for the loser's checkIn() call:
  //  (a) it loses at insert time — a raw 23505 (isUniqueViolation), or
  //  (b) the winner has already fully committed by the time the loser's
  //      checkIn() runs its own opId pre-check, so checkIn() throws
  //      CheckInError('op_conflict') instead of ever reaching the insert.
  // Both are caught here, re-run the opId lookup to fetch the winner, and
  // clean up the orphan person+membership this losing attempt created rather
  // than leaving it behind.
  let orphan: typeof people.$inferSelect | undefined;
  try {
    const [person] = await db.insert(people).values({
      fullName: input.fullName.trim(),
      industry: input.industry === null ? null : input.industry.trim(),
      company: trimOrNull(input.company),
      email: input.email.trim(),
      phone: trimOrNull(input.phone),
    }).returning();
    orphan = person;
    await db.insert(memberships).values({ personId: person.id, status: 'visitor' });
    const result = await checkIn(db, {
      personId: person.id, clientOpId: input.clientOpId, source: 'kiosk', now: input.now,
    });

    // Defense in depth: interleaving (b) above is expected to throw
    // op_conflict rather than return here, but if checkIn() ever reports a
    // dedupe for a DIFFERENT personId without throwing, treat it the same
    // way rather than handing back a person/attendance mismatch.
    if (result.deduped && result.attendance.personId !== person.id) {
      await deleteOrphan(db, person.id);
      const [winner] = await db.select().from(people).where(eq(people.id, result.attendance.personId));
      return { person: winner, ...result };
    }
    return { person, ...result };
  } catch (err) {
    if (!isOpRaceLoss(err)) throw err;
    const rewon = await db.select().from(attendance).where(eq(attendance.clientOpId, input.clientOpId));
    if (!rewon[0]) throw err;
    if (orphan) await deleteOrphan(db, orphan.id);
    const [winner] = await db.select().from(people).where(eq(people.id, rewon[0].personId));
    return { person: winner, attendance: rewon[0], deduped: true, voided: rewon[0].voidedAt !== null };
  }
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
