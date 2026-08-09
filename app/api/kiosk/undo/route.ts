import { z } from 'zod';
import { getDb } from '@/lib/db';
import { voidCheckIn } from '@/lib/checkins';
import { getOrCreateMeetingFor } from '@/lib/meetings';

const Body = z.object({ attendanceId: z.string().uuid() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  const db = getDb();
  const meeting = await getOrCreateMeetingFor(db, new Date());
  const row = await voidCheckIn(db, {
    attendanceId: parsed.data.attendanceId, by: 'kiosk', meetingId: meeting.id,
  });
  return Response.json({ undone: row !== null });
}
