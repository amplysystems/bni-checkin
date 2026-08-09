import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { attendance, people } from '@/db/schema';
import { checkIn, voidCheckIn, CheckInError } from '@/lib/checkins';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { requireAdmin } from '@/lib/admin-guard';

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const db = getDb();
  const meeting = await getOrCreateMeetingFor(db, new Date());
  const rows = await db.select({
    id: attendance.id, personId: attendance.personId, kind: attendance.kind,
    visitNumber: attendance.visitNumber, checkedInAt: attendance.checkedInAt,
    checkedInBy: attendance.checkedInBy, fullName: people.fullName,
  }).from(attendance)
    .innerJoin(people, eq(people.id, attendance.personId))
    .where(and(eq(attendance.meetingId, meeting.id), isNull(attendance.voidedAt)));
  return Response.json({ meetingDate: meeting.meetingDate, attendance: rows });
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), personId: z.string().uuid() }),
  z.object({ action: z.literal('void'), attendanceId: z.string().uuid() }),
]);

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  const db = getDb();
  const by = `admin:${guard.email}`;

  if (parsed.data.action === 'add') {
    try {
      const r = await checkIn(db, {
        personId: parsed.data.personId, clientOpId: crypto.randomUUID(), source: by,
      });
      return Response.json({ attendance: r.attendance });
    } catch (e) {
      if (e instanceof CheckInError) return Response.json({ error: e.code }, { status: 400 });
      throw e;
    }
  }

  // meetingId is intentionally omitted here (unlike the kiosk undo route) so
  // an admin can void any date's attendance row, not just today's.
  const row = await voidCheckIn(db, { attendanceId: parsed.data.attendanceId, by });
  if (!row) return Response.json({ error: 'Not found or already voided' }, { status: 404 });
  return Response.json({ attendance: row });
}
