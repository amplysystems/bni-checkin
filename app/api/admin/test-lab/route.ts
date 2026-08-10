// Phase 2 admin "Test Lab" (System test section) — lets an admin preview or
// send THEMSELVES a real copy of every outbound template using obviously-
// fake SAMPLE data (lib/emails/test-lab.ts), completely isolated from the
// production pipeline: never creates an email_messages row, never touches
// attendance/visitors/meetings, never increments anything, never notifies
// leadership. Same requireAdmin-first guard as every other admin route.
//
// SECURITY: the recipient for a 'send' action is ALWAYS the calling admin's
// own session email, resolved server-side from requireAdmin()'s guard —
// there is no `to`/recipient field anywhere in the request schema below, so
// a client can't point a test send at anyone else no matter what it sends.
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-guard';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { buildTestLabContent, TEST_LAB_KINDS, TEST_LAB_SEND_KINDS } from '@/lib/emails/test-lab';
import { sendTestEmail } from '@/lib/emails/send';

// 20/hour/IP — generous for an admin clicking through every template a
// handful of times while testing, tight enough that a leaked admin session
// (or a scripted loop) can't turn "send me a copy" into a real send flood
// against the Resend account. Same route-budget shape as lib/rate-limit.ts's
// existing KIOSK_RATE_LIMITS / OTP_VERIFY_RATE_LIMIT, kept local here since
// nothing else shares this particular budget.
const TEST_EMAIL_RATE_LIMIT = { route: 'test-email', limit: 20, windowMinutes: 60 };

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), kind: z.enum(TEST_LAB_KINDS) }),
  z.object({ action: z.literal('send'), kind: z.enum(TEST_LAB_SEND_KINDS) }),
]);

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  const d = parsed.data;

  // Preview never sends anything, never touches the database (see
  // lib/emails/test-lab.ts's own header — every kind is now pure
  // string-building), and never checks the rate limit — free to click
  // repeatedly.
  if (d.action === 'preview') {
    const { subject, html } = await buildTestLabContent(d.kind);
    return Response.json({ subject, html });
  }

  // action === 'send': rate-limited BEFORE building or sending anything —
  // same cheapest-check-first ordering as every kiosk POST route (see e.g.
  // app/api/kiosk/checkin/route.ts). getDb() is only needed for this
  // check — buildTestLabContent below no longer touches the database at
  // all.
  const db = getDb();
  const { allowed } = await checkRateLimit(db, { ip: getClientIp(req), ...TEST_EMAIL_RATE_LIMIT });
  if (!allowed) return Response.json({ error: 'rate_limited' }, { status: 429 });

  const { subject, html, text } = await buildTestLabContent(d.kind);
  await sendTestEmail({ to: guard.email, subject, html, text });
  return Response.json({ sent: true });
}
