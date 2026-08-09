import { meetings } from '@/db/schema';
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
