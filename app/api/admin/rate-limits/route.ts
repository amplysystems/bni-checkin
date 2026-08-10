import { z } from 'zod';
import { getDb } from '@/lib/db';
import { rateLimits } from '@/db/schema';
import { requireAdmin } from '@/lib/admin-guard';

const Body = z.object({ action: z.literal('reset') });

// Break-glass control for the kiosk rate limiter (lib/rate-limit.ts) — the
// manual escape hatch if a legitimate Wednesday burst ever trips a budget
// live, with no other recovery path until the window naturally rolls over.
// A total wipe rather than per-IP/per-route: the table is tiny (one row
// per active ip:route:window) and self-heals within the hour regardless,
// so there's no real value in a more surgical delete — it would just add
// complexity an admin under pressure at the kiosk doesn't need.
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });

  const deleted = await getDb().delete(rateLimits).returning({ key: rateLimits.key });
  return Response.json({ reset: true, cleared: deleted.length });
}
