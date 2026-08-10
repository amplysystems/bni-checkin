// Task 5 (admin email center): list + act on email_messages. Same guard
// pattern as every other admin route (requireAdmin first, always) and the
// same "never reimplement the state machine" discipline as lib/emails/
// tick.ts — every mutation here is a call into lib/emails/engine.ts or
// lib/emails/compile.ts, never a direct write to email_messages.
//
// P2-4 REVIEW CARRY-INS this route exists to satisfy: sendNow doubles as
// the failed-row Retry path (engine.ts's sendNow already accepts any
// pre-send state, including 'failed' — this route adds no special casing,
// the UI just relabels the button); the 'compile' action lets an admin
// createDrafts() for an arbitrary meetingDate (special/non-Wednesday
// meetings the cron never compiles); 'preview' never sends anything, just
// reads.
import { z } from 'zod';
import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { emailMessages, meetings, people, type EmailMessage } from '@/db/schema';
import { requireAdmin } from '@/lib/admin-guard';
import { findMeetingByDate, meetingHasAttendance } from '@/lib/meetings';
import {
  approve, createDrafts, EngineError, getSettings, scheduledTimeFor, sendNow,
} from '@/lib/emails/engine';
import { compileForMeeting, CompileError } from '@/lib/emails/compile';
import { isSafeModeActive } from '@/lib/emails/send';

// "Last 8 meetings' worth" per the plan — a smaller window than the
// Meetings panel's own 26 (app/api/admin/meetings/route.ts): email history
// is a recent-operations view (did this week's sends go out, is anything
// failed right now), not an audit archive.
const MEETING_LIMIT = 8;
// weekly_export rows have no meetingId to scope by (see db/schema.ts's
// header comment on the type column) — capped separately, generously
// enough that "latest export" never has to reach past what's returned here.
const WEEKLY_EXPORT_LIMIT = 5;
// P2-6 carry-in (Task 8): rsvp_notice rows also have no meetingId — same
// "recent, not an archive" reasoning as WEEKLY_EXPORT_LIMIT above, sized a
// bit more generously since these are the failed-rows-recovery invariant's
// whole reason for being included here at all (a failed/stuck rsvp_notice
// otherwise has no other admin surface to retry from).
const RSVP_NOTICE_LIMIT = 20;

function labelFor(message: EmailMessage, nameByEmail: Map<string, string>): string {
  switch (message.type) {
    case 'visitor_thankyou': {
      // recipients[0] is the visitor's real address even under SAFE_MODE —
      // that redirect only happens at send time (lib/emails/send.ts), never
      // in the compiled/stored row. Falls back to the bare email when the
      // person can't be matched (e.g. their roster email changed since).
      const email = message.recipients[0];
      const name = email ? (nameByEmail.get(email) ?? email) : 'visitor';
      return `Visitor thank-you · ${name}`;
    }
    case 'leadership_report': return 'Weekly report';
    case 'approval_notice': return 'Approval notice';
    case 'weekly_export': return 'Weekly export';
    // The subject line already names who and what ("{fullName} plans to
    // visit Wednesday" / "{fullName} is interested in membership" — see
    // emails/rsvp-notice.ts), which EmailRow renders right below this
    // label — no name lookup needed the way visitor_thankyou's does.
    case 'rsvp_notice': return 'RSVP notice';
    default: return message.type;
  }
}

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const db = getDb();

  const meetingRows = await db.select({ id: meetings.id, meetingDate: meetings.meetingDate })
    .from(meetings).orderBy(desc(meetings.meetingDate)).limit(MEETING_LIMIT);
  const meetingIds = meetingRows.map((m) => m.id);
  const meetingDateById = new Map(meetingRows.map((m) => [m.id, m.meetingDate]));

  const meetingMessages = meetingIds.length > 0
    ? await db.select().from(emailMessages).where(inArray(emailMessages.meetingId, meetingIds))
    : [];
  const weeklyExportMessages = await db.select().from(emailMessages)
    .where(eq(emailMessages.type, 'weekly_export'))
    .orderBy(desc(emailMessages.createdAt))
    .limit(WEEKLY_EXPORT_LIMIT);
  // P2-6 REQUIRED carry-in: rsvp_notice rows (meetingId always null) were
  // entirely absent from this listing before — invisible when failed,
  // which broke the failed-rows-recovery invariant this whole route exists
  // to satisfy (see this file's own header comment).
  const rsvpNoticeMessages = await db.select().from(emailMessages)
    .where(eq(emailMessages.type, 'rsvp_notice'))
    .orderBy(desc(emailMessages.createdAt))
    .limit(RSVP_NOTICE_LIMIT);

  const allMessages = [...meetingMessages, ...weeklyExportMessages, ...rsvpNoticeMessages];

  // Visitor display names: a best-effort join of the stored recipient email
  // against the current roster (not a stored personId — email_messages
  // never had one, see lib/emails/compile.ts's VisitorThankyouDraft vs. what
  // createDrafts actually persists). Fine for a display label; the person's
  // real identity for every state transition is still the message row's id.
  const visitorEmails = Array.from(new Set(
    allMessages
      .filter((m) => m.type === 'visitor_thankyou')
      .map((m) => m.recipients[0])
      .filter((e): e is string => Boolean(e)),
  ));
  const nameByEmail = new Map<string, string>();
  if (visitorEmails.length > 0) {
    const matches = await db.select({
      email: people.email, fullName: people.fullName, displayName: people.displayName,
    }).from(people).where(inArray(people.email, visitorEmails));
    for (const p of matches) {
      if (p.email) nameByEmail.set(p.email, p.displayName ?? p.fullName);
    }
  }

  const settingsRow = await getSettings(db);

  const out = allMessages.map((m) => {
    const meetingDate = m.meetingId ? meetingDateById.get(m.meetingId) ?? null : null;
    // Only a 'scheduled' row has a meaningful "would send at" instant worth
    // showing (spec chip: "Scheduled 5:30 PM") — draft/awaiting_approval
    // haven't been authorized to send yet, and sent/failed/sending have
    // their own timestamps (sentAt / error) already.
    const scheduledFor = m.state === 'scheduled' && meetingDate
      ? scheduledTimeFor(m, meetingDate, settingsRow)
      : null;
    return {
      id: m.id,
      type: m.type,
      label: labelFor(m, nameByEmail),
      state: m.state,
      meetingId: m.meetingId,
      meetingDate,
      recipientsCount: m.recipients.length,
      subject: m.subject,
      scheduledFor,
      sentAt: m.sentAt,
      error: m.error,
      providerMessageId: m.providerMessageId,
      // Task 7: null until the first Resend webhook event for this
      // message's providerMessageId arrives (see db/schema.ts's column
      // comment) — the UI only renders a delivery chip when this is
      // non-null, so "no webhook configured yet" and "sent, webhook just
      // hasn't landed" both read as "no extra chip," not a false status.
      deliveryStatus: m.deliveryStatus,
      createdAt: m.createdAt,
    };
  });

  // Surfaced so the admin UI can show a "test mode is on" banner — without
  // this, a run of 'Sent' chips looks identical whether real visitors got
  // the email or every one of them got silently redirected to the owner's
  // own inbox with a [SAFE→…] subject prefix (lib/emails/send.ts).
  return Response.json({ messages: out, safeMode: isSafeModeActive() });
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), id: z.string().uuid() }),
  z.object({ action: z.literal('approve'), id: z.string().uuid() }),
  z.object({ action: z.literal('sendNow'), id: z.string().uuid() }),
  z.object({
    action: z.literal('compile'),
    meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD'),
  }),
]);

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  const db = getDb();
  const d = parsed.data;
  const by = `admin:${guard.email}`;

  // Special-meeting path (P2-4 carry-in): createDrafts for whatever meeting
  // actually falls on this date — the cron only ever compiles TODAY's
  // meeting, so this is the only path a non-Wednesday special meeting's
  // drafts ever get built through.
  //
  // CRITICAL (review carry-in): gated with the EXACT same two checks
  // lib/emails/tick.ts's cron sweep applies before it will ever call
  // createDrafts for today's meeting — status !== 'canceled' AND
  // meetingHasAttendance. This is required, not a nicety: createDrafts is
  // create-only (ON CONFLICT DO NOTHING on send_key — see its own header
  // comment), so a premature compile against a canceled or zero-attendance
  // meeting would PERMANENTLY claim that meeting's send_key rows. The real
  // compile later that evening, once people have actually checked in,
  // would then find every send_key already "taken" and silently skip —
  // no drafts, no error, no visible sign anything went wrong until Jason
  // notices no emails ever arrived.
  if (d.action === 'compile') {
    const meeting = await findMeetingByDate(db, d.meetingDate);
    if (!meeting) return Response.json({ error: 'meeting_not_found' }, { status: 404 });
    if (meeting.status === 'canceled') {
      return Response.json({ error: 'That meeting was canceled.' }, { status: 400 });
    }
    if (!(await meetingHasAttendance(db, meeting.id))) {
      return Response.json({
        error: 'That meeting has no check-ins yet — emails get ready on their own once people check in.',
      }, { status: 400 });
    }
    const { created, skipped } = await createDrafts(db, meeting.id);
    return Response.json({ meetingId: meeting.id, created: created.length, skipped });
  }

  // Preview never sends anything — it either returns the exact HTML that
  // WOULD send (the stored bodySnapshot, the common case) or, if that's
  // somehow missing, recompiles live from compileForMeeting the same way
  // createDrafts itself would build it. Either way this function makes zero
  // calls into lib/emails/send.ts.
  if (d.action === 'preview') {
    const [message] = await db.select().from(emailMessages).where(eq(emailMessages.id, d.id));
    if (!message) return Response.json({ error: 'message_not_found' }, { status: 400 });
    if (message.bodySnapshot) {
      return Response.json({ subject: message.subject, html: message.bodySnapshot });
    }
    if (!message.meetingId) {
      return Response.json({ error: 'nothing_to_preview' }, { status: 400 });
    }
    try {
      const { drafts } = await compileForMeeting(db, message.meetingId);
      const draft = drafts.find((dr) => dr.sendKey === message.sendKey);
      if (!draft) return Response.json({ error: 'nothing_to_preview' }, { status: 400 });
      return Response.json({ subject: draft.subject, html: draft.html });
    } catch (e) {
      if (e instanceof CompileError) return Response.json({ error: e.code }, { status: 400 });
      throw e;
    }
  }

  // approve / sendNow: thin passthroughs to the engine. Every failure mode
  // (message_not_found, not_awaiting_approval, meeting_not_found) maps to a
  // clean 400 — this route never reimplements the state machine's own
  // judgment about what's a valid transition.
  try {
    if (d.action === 'approve') {
      const updated = await approve(db, d.id, by);
      return Response.json({ message: updated });
    }
    const updated = await sendNow(db, d.id, by);
    return Response.json({ message: updated });
  } catch (e) {
    if (e instanceof EngineError) return Response.json({ error: e.code }, { status: 400 });
    throw e;
  }
}
