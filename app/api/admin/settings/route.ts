// Task 5 (admin email center): the settings half — approve-mode toggle,
// the two send-time inputs, and the report recipients list. Same guard
// pattern as every other admin route.
//
// P2-4 REVIEW CARRY-IN this route exists to enforce: send-time inputs are
// HARD-CLAMPED to [16:45, 19:45] CT, the window the email cron actually
// sweeps (spec/plan Task 4) — a time outside it would silently never fire,
// so this is rejected server-side (never just a client-side nicety) with a
// plain-English error naming the window.
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { settings as settingsTable } from '@/db/schema';
import { requireAdmin } from '@/lib/admin-guard';
import { getSettings } from '@/lib/emails/engine';

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_TIME = '16:45';
const MAX_TIME = '19:45';
const CLAMP_MESSAGE =
  "Send times have to be between 4:45 PM and 7:45 PM Chicago time — that's the window the automatic sender checks.";
const MAX_RECIPIENTS = 10;

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
const MIN_MINUTES = timeToMinutes(MIN_TIME);
const MAX_MINUTES = timeToMinutes(MAX_TIME);

const SendTime = z.string()
  .regex(TIME_REGEX, 'Enter a time as HH:MM, like 17:00')
  .refine((v) => {
    const mins = timeToMinutes(v);
    return mins >= MIN_MINUTES && mins <= MAX_MINUTES;
  }, { message: CLAMP_MESSAGE });

const CAREY_EMAIL_REQUIRED_MESSAGE = "Add Carey's email before turning this on.";

const Body = z.object({
  approveMode: z.boolean().optional(),
  reportSendTime: SendTime.optional(),
  thankyouSendTime: SendTime.optional(),
  reportRecipients: z.array(z.string().trim().email().max(320)).max(MAX_RECIPIENTS).optional(),
  // P2-6 carry-in. careyEmail is nullable (clearing it back out is valid —
  // an admin who no longer wants Carey notified) as well as optional
  // (untouched, in which case the merge below falls back to whatever's
  // already stored).
  rsvpNotifyCarey: z.boolean().optional(),
  careyEmail: z.string().trim().email().max(320).nullable().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No changes to save' });

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const settingsRow = await getSettings(getDb());
  return Response.json({ settings: settingsRow });
}

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid request';
    return Response.json({ error: message }, { status: 400 });
  }
  const db = getDb();
  const fields = parsed.data;

  // P2-6 carry-in: the toggle can only ever end up ON with an address on
  // file — checked against the RESULTANT state (this request's fields
  // merged over whatever's already stored), not just this request's own
  // fields in isolation, since "turn the toggle on" and "set the address"
  // are two independent saves from the settings card's own two controls
  // (see app/admin/admin-client.tsx) and each must be safe on its own.
  const current = await getSettings(db);
  const resultantCarey = fields.rsvpNotifyCarey ?? current.rsvpNotifyCarey;
  const resultantCareyEmail = 'careyEmail' in fields ? fields.careyEmail ?? null : current.careyEmail;
  if (resultantCarey && !resultantCareyEmail) {
    return Response.json({ error: CAREY_EMAIL_REQUIRED_MESSAGE }, { status: 400 });
  }

  // Upsert (mirrors getOrCreateMeetingFor's own onConflictDoUpdate pattern)
  // rather than a bare UPDATE: the singleton settings row is always seeded
  // by scripts/seed.ts in practice, but a route that only works when that
  // happened to already run is a landmine — this way POST works correctly
  // either way, and only ever touches the fields actually sent.
  const [row] = await db.insert(settingsTable)
    .values({ id: 1, ...fields })
    .onConflictDoUpdate({ target: settingsTable.id, set: fields })
    .returning();

  return Response.json({ settings: row });
}
