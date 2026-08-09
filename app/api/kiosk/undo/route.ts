import { z } from 'zod';
import { getDb } from '@/lib/db';
import { voidCheckIn } from '@/lib/checkins';

const Body = z.object({ attendanceId: z.string().uuid() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  const row = await voidCheckIn(getDb(), { attendanceId: parsed.data.attendanceId, by: 'kiosk' });
  return Response.json({ undone: row !== null });
}
