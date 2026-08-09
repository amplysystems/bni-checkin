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

export async function checkIn(db: Db, input: CheckInInput) {
  const now = input.now ?? new Date();
  const meeting = await getOrCreateMeetingFor(db, now);

  const replayed = await db.select().from(attendance)
    .where(eq(attendance.clientOpId, input.clientOpId));
  if (replayed[0]) return { attendance: replayed[0], deduped: true };

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
    return { attendance: row, deduped: false };
  } catch {
    const existing = await activeAttendance(db, input.personId, meeting.id);
    if (existing) return { attendance: existing, deduped: true };
    throw new Error('check-in failed for a reason other than duplicate');
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
