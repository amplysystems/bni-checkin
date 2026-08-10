import { z } from 'zod';
import { getDb } from '@/lib/db';
import { voidCheckIn } from '@/lib/checkins';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { checkRateLimit, getClientIp, KIOSK_RATE_LIMITS } from '@/lib/rate-limit';

const Body = z.object({ attendanceId: z.string().uuid() });

export async function POST(req: Request) {
  const db = getDb();
  const { allowed } = await checkRateLimit(db, { ip: getClientIp(req), ...KIOSK_RATE_LIMITS.undo });
  if (!allowed) return Response.json({ error: 'rate_limited' }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  const meeting = await getOrCreateMeetingFor(db, new Date());
  const row = await voidCheckIn(db, {
    attendanceId: parsed.data.attendanceId, by: 'kiosk', meetingId: meeting.id,
  });
  return Response.json({ undone: row !== null });
}
