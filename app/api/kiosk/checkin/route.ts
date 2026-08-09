import { z } from 'zod';
import { getDb } from '@/lib/db';
import { checkIn, CheckInError } from '@/lib/checkins';

const Body = z.object({ personId: z.string().uuid(), clientOpId: z.string().min(8) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  try {
    const r = await checkIn(getDb(), { ...parsed.data, source: 'kiosk' });
    return Response.json({
      checkedIn: !r.voided, deduped: r.deduped, voided: r.voided,
      attendanceId: r.attendance.id, checkedInAt: r.attendance.checkedInAt,
      visitNumber: r.attendance.visitNumber,
    });
  } catch (e) {
    if (e instanceof CheckInError) return Response.json({ error: e.code }, { status: 400 });
    throw e;
  }
}
