import { z } from 'zod';
import { getDb } from '@/lib/db';
import { checkIn, CheckInError } from '@/lib/checkins';
import { checkRateLimit, getClientIp, KIOSK_RATE_LIMITS } from '@/lib/rate-limit';

const Body = z.object({ personId: z.string().uuid(), clientOpId: z.string().min(8).max(128) });

export async function POST(req: Request) {
  const db = getDb();
  const { allowed } = await checkRateLimit(db, { ip: getClientIp(req), ...KIOSK_RATE_LIMITS.checkin });
  if (!allowed) return Response.json({ error: 'rate_limited' }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  try {
    const r = await checkIn(db, { ...parsed.data, source: 'kiosk' });
    return Response.json({
      checkedIn: !r.voided, deduped: r.deduped, voided: r.voided,
      attendanceId: r.attendance.id, checkedInAt: r.attendance.checkedInAt,
      visitNumber: r.attendance.visitNumber,
    });
  } catch (e) {
    if (e instanceof CheckInError) {
      const status = e.code === 'op_conflict' ? 409 : 400;
      return Response.json({ error: e.code }, { status });
    }
    throw e;
  }
}
