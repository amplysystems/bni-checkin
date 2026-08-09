import { and, eq, isNull, desc, count } from 'drizzle-orm';
import { attendance, memberships, people, personRoles } from '@/db/schema';
import type { Db } from '@/lib/db';
import { getOrCreateMeetingFor } from '@/lib/meetings';

export type CheckInInput = {
  personId: string;
  clientOpId: string;
  source: string; // 'kiosk' | 'admin:{email}'
  now?: Date;
};

export class CheckInError extends Error {
  constructor(public code: 'person_not_found' | 'person_deactivated') { super(code); }
}

async function resolveKind(db: Db, personId: string): Promise<'member' | 'leadership' | 'visitor'> {
  const roles = await db.select().from(personRoles).where(eq(personRoles.personId, personId));
  if (roles.some((r) => r.role === 'leadership')) return 'leadership';
  const ms = await db.select().from(memberships)
    .where(and(eq(memberships.personId, personId), isNull(memberships.endedAt)))
    .orderBy(desc(memberships.startedAt));
  if (ms[0]?.status === 'member') return 'member';
  return 'visitor';
}

async function activeAttendance(db: Db, personId: string, meetingId: string) {
  const rows = await db.select().from(attendance).where(and(
    eq(attendance.personId, personId),
    eq(attendance.meetingId, meetingId),
    isNull(attendance.voidedAt),
  ));
  return rows[0];
}

// Postgres unique_violation. Drivers nest this differently: neon-http/pg
// surface `code` directly on the thrown error, while drizzle's pglite
// wrapper puts the original pg error one level down on `.cause`. Check both.
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === '23505') return true;
  const causeCode = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
  return causeCode === '23505';
}

export async function checkIn(db: Db, input: CheckInInput) {
  const now = input.now ?? new Date();
  const meeting = await getOrCreateMeetingFor(db, now);

  // Unfiltered by design: the void is authoritative for a replayed
  // clientOpId. A stale duplicate must never resurrect a check-in or attempt
  // a fresh insert (which would violate the total clientOpId unique
  // constraint anyway) — it just reports back what actually happened.
  const replayed = await db.select().from(attendance)
    .where(eq(attendance.clientOpId, input.clientOpId));
  if (replayed[0]) {
    return { attendance: replayed[0], deduped: true, voided: replayed[0].voidedAt !== null };
  }

  const [person] = await db.select().from(people).where(eq(people.id, input.personId));
  if (!person) throw new CheckInError('person_not_found');
  if (person.deactivatedAt) throw new CheckInError('person_deactivated');

  const kind = await resolveKind(db, input.personId);
  let visitNumber: number | null = null;
  if (kind === 'visitor') {
    const [prior] = await db.select({ n: count() }).from(attendance).where(and(
      eq(attendance.personId, input.personId),
      eq(attendance.kind, 'visitor'),
      isNull(attendance.voidedAt),
    ));
    visitNumber = Number(prior.n) + 1;
  }

  try {
    const [row] = await db.insert(attendance).values({
      personId: input.personId,
      meetingId: meeting.id,
      kind,
      visitNumber,
      checkedInAt: now,
      checkedInBy: input.source,
      clientOpId: input.clientOpId,
    }).returning();
    return { attendance: row, deduped: false, voided: false };
  } catch (err) {
    // Only a unique-constraint race (someone else won uniq_active_attendance
    // or clientOpId between our reads and this insert) is a dedupe path —
    // re-read the winning row. Anything else is a real failure; rethrow it
    // as-is rather than masking it with a generic message.
    if (!isUniqueViolation(err)) throw err;
    const existing = await activeAttendance(db, input.personId, meeting.id);
    if (existing) return { attendance: existing, deduped: true, voided: false };
    throw err;
  }
}

export async function voidCheckIn(db: Db, { attendanceId, by }: { attendanceId: string; by: string }) {
  const [row] = await db.update(attendance)
    .set({ voidedAt: new Date(), voidedBy: by })
    .where(and(eq(attendance.id, attendanceId), isNull(attendance.voidedAt)))
    .returning();
  return row ?? null;
}

export async function kioskRoster(db: Db, now: Date) {
  const meeting = await getOrCreateMeetingFor(db, now);
  // Assumes seed convention: leadership people get a person_roles row but no
  // memberships row, so this status='member' join agrees with resolveKind()
  // about who belongs in the member grid (leadership/visitors excluded).
  const members = await db.select({
    id: people.id, fullName: people.fullName, displayName: people.displayName,
    industry: people.industry, company: people.company,
  }).from(people)
    .innerJoin(memberships, and(
      eq(memberships.personId, people.id),
      eq(memberships.status, 'member'),
      isNull(memberships.endedAt),
    ))
    .where(isNull(people.deactivatedAt));

  const checked = await db.select().from(attendance).where(and(
    eq(attendance.meetingId, meeting.id), isNull(attendance.voidedAt),
  ));
  const byPerson = new Map(checked.map((c) => [c.personId, c]));

  return {
    meetingDate: meeting.meetingDate,
    members: members
      .map((m) => ({ ...m, checkedInAt: byPerson.get(m.id)?.checkedInAt ?? null,
                     attendanceId: byPerson.get(m.id)?.id ?? null }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
  };
}
