import { and, eq, isNull } from 'drizzle-orm';
import { attendance, meetings } from '@/db/schema';
import type { Db } from '@/lib/db';
import { chicagoDateString, meetingStartUtc } from '@/lib/time';

export async function getOrCreateMeetingFor(db: Db, now: Date) {
  const dateStr = chicagoDateString(now);
  const [meeting] = await db.insert(meetings)
    .values({ meetingDate: dateStr, startsAt: meetingStartUtc(dateStr) })
    .onConflictDoUpdate({ target: meetings.meetingDate, set: { meetingDate: dateStr } })
    .returning();
  return meeting;
}

// Read-only lookup (never creates) — used by the email cron tick
// (lib/emails/tick.ts) to check whether "today" already has a meeting row
// at all before deciding whether to compile drafts for it. Unlike
// getOrCreateMeetingFor, a cron tick has no business conjuring a meeting
// into existence; only a kiosk check-in should ever do that.
export async function findMeetingByDate(db: Db, dateStr: string) {
  const [meeting] = await db.select().from(meetings).where(eq(meetings.meetingDate, dateStr));
  return meeting ?? null;
}

// Any non-voided check-in recorded against this meeting. The tick's gate
// is "a day that HAS a meeting with attendance" (plan, Task 4) — a bare
// meetings row existing isn't enough, since a canceled or simply
// nobody-showed-up Wednesday should never trigger drafts/sends.
export async function meetingHasAttendance(db: Db, meetingId: string): Promise<boolean> {
  const [row] = await db.select({ id: attendance.id }).from(attendance)
    .where(and(eq(attendance.meetingId, meetingId), isNull(attendance.voidedAt)))
    .limit(1);
  return row !== undefined;
}
