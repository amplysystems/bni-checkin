// Email send state machine, per spec §6. `draft -> awaiting_approval |
// scheduled -> sending -> sent | failed`. Every write that moves a message
// forward is a state-scoped UPDATE ... WHERE (never a blind write), so two
// overlapping callers (a cron tick racing an admin's "Send now" click, or
// two ticks of the same cron) can each only win a transition once — the
// loser's UPDATE matches 0 rows and is a structural no-op. Combined with
// send_key's uniqueness (lib/emails/send-keys.ts), double-sending the same
// email is not just guarded against, it's unreachable.
//
// This module owns ALL email_messages state/timestamp writes; lib/emails/
// send.ts is deliberately DB-free and only performs the Resend fetch.

import { and, eq, isNull, lt, notInArray, or } from 'drizzle-orm';
import { emailMessages, meetings, settings as settingsTable, type EmailMessage } from '@/db/schema';
import type { Db } from '@/lib/db';
import { chicagoTimeToUtc } from '@/lib/time';
import { approvalNoticeHtml, approvalNoticeSubject } from '@/emails/approval-notice';
import { rsvpNoticeHtml, rsvpNoticeSubject, type RsvpNoticePurpose } from '@/emails/rsvp-notice';
import { compileForMeeting, formatMeetingDateLabel } from './compile';
import { OWNER_EMAIL, siteUrl } from './constants';
import { approvalNoticeSendKey, rsvpNoticeSendKey } from './send-keys';
import { sendEmailMessage, type SendableMessage } from './send';

export type EmailState = EmailMessage['state'];

const MAX_ATTEMPTS = 3;
const INFLIGHT_OR_TERMINAL: EmailState[] = ['sending', 'sent'];

export class EngineError extends Error {
  constructor(public code: 'message_not_found' | 'not_awaiting_approval' | 'meeting_not_found', message?: string) {
    super(message ?? code);
  }
}

type SettingsRow = typeof settingsTable.$inferSelect;

// Spec §5: visitor thank-you 5:00 PM CT, leadership report 5:30 PM CT.
// Kept in sync with db/schema.ts's column defaults by hand (this constant
// only matters when the row is missing entirely, e.g. a bare test DB) —
// see migration 0003 for the incident where these two drifted apart.
const SETTINGS_DEFAULTS: SettingsRow = {
  id: 1, approveMode: true, reportSendTime: '17:30', thankyouSendTime: '17:00',
  reportRecipients: [], openSeats: [],
};

// Falls back to schema defaults if the singleton row hasn't been seeded
// yet — keeps the engine usable (e.g. in a bare test DB) without forcing
// every caller to seed settings first. Exported so Task 5's admin routes
// (app/api/admin/emails, app/api/admin/settings) read the exact same
// fallback the engine itself relies on, rather than re-declaring it.
export async function getSettings(db: Db): Promise<SettingsRow> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1));
  return row ?? SETTINGS_DEFAULTS;
}

// Exported so app/api/admin/emails' GET can show a 'scheduled' row's actual
// send time (spec: state chips read "Scheduled 5:30 PM", not just
// "Scheduled") without re-deriving this per-type time lookup itself. Only
// meaningful for leadership_report/visitor_thankyou — the two types that
// ever pass through 'scheduled' at all (approval_notice and weekly_export
// never do, see their own module headers).
export function scheduledTimeFor(message: EmailMessage, meetingDateStr: string, settingsRow: SettingsRow): Date {
  const hhmm = message.type === 'leadership_report' ? settingsRow.reportSendTime : settingsRow.thankyouSendTime;
  return chicagoTimeToUtc(meetingDateStr, hhmm);
}

async function loadMessageAndMeetingDate(db: Db, id: string) {
  const [message] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
  if (!message) throw new EngineError('message_not_found');
  if (!message.meetingId) throw new EngineError('meeting_not_found', 'message has no meetingId');
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, message.meetingId));
  if (!meeting) throw new EngineError('meeting_not_found');
  return { message, meeting };
}

// Compiles the meeting's drafts and persists them as email_messages rows,
// idempotently. A message with the same send_key already existing (in ANY
// state — draft, awaiting_approval, already sent, whatever) is left
// untouched: createDrafts only ever CREATES, it never overwrites live
// content. "Preview always shows the current compilation" (spec §6) is
// satisfied by callers (Task 5's admin Preview) invoking compileForMeeting
// directly for live data, rather than by this function re-writing rows.
export async function createDrafts(db: Db, meetingId: string): Promise<{ created: EmailMessage[]; skipped: number }> {
  const { drafts } = await compileForMeeting(db, meetingId);
  const settingsRow = await getSettings(db);
  const created: EmailMessage[] = [];
  let skipped = 0;

  for (const draft of drafts) {
    const [inserted] = await db.insert(emailMessages).values({
      sendKey: draft.sendKey,
      type: draft.type,
      meetingId,
      recipients: draft.recipients,
      subject: draft.subject,
      bodySnapshot: draft.html,
      state: 'draft',
    }).onConflictDoNothing({ target: emailMessages.sendKey }).returning();

    if (!inserted) {
      skipped += 1;
      continue;
    }

    const nextState: EmailState = settingsRow.approveMode ? 'awaiting_approval' : 'scheduled';
    const [updated] = await db.update(emailMessages)
      .set({ state: nextState })
      .where(eq(emailMessages.id, inserted.id))
      .returning();
    created.push(updated);
  }

  return { created, skipped };
}

// Approve semantics (spec §6): approving BEFORE the scheduled time just
// authorizes the send — the row moves to 'scheduled' and the normal
// executeDue() sweep sends it at the right time. Approving AFTER the
// scheduled time has already passed sends immediately (there's no future
// tick left to wait for). Either branch stamps approvedBy/approvedAt.
//
// The schema's separate 'approved' state is intentionally never used as a
// distinct resting state here: this app has no meaningful moment between
// "Jason clicked approve" and "its resulting target state" (scheduled, or
// sending-now) — recording the approval metadata on the SAME row/write as
// the state transition is simpler and just as auditable.
//
// Only a message currently 'awaiting_approval' can be approved — approving
// an already-scheduled/sent/failed message doesn't mean anything, and
// guards a stale double-click from doing something surprising.
export async function approve(db: Db, id: string, by: string, now: Date = new Date()): Promise<EmailMessage | null> {
  const { message, meeting } = await loadMessageAndMeetingDate(db, id);
  if (message.state !== 'awaiting_approval') throw new EngineError('not_awaiting_approval');

  const settingsRow = await getSettings(db);
  const scheduledAt = scheduledTimeFor(message, meeting.meetingDate, settingsRow);

  if (now < scheduledAt) {
    const [updated] = await db.update(emailMessages)
      .set({ state: 'scheduled', approvedBy: by, approvedAt: now })
      .where(and(eq(emailMessages.id, id), eq(emailMessages.state, 'awaiting_approval')))
      .returning();
    return updated ?? null;
  }

  await db.update(emailMessages)
    .set({ approvedBy: by, approvedAt: now })
    .where(and(eq(emailMessages.id, id), eq(emailMessages.state, 'awaiting_approval')));
  return sendWithRetry(db, id);
}

// Send now = approve + send immediately, from any pre-send state (draft,
// awaiting_approval, scheduled, or failed — a manual nudge past the
// automatic 3-attempt retry). Per spec §6: "If a send is already
// sending/sent, both Send now and the scheduler are no-ops." The check
// here is a cheap short-circuit for the common case; the REAL guard
// against a race is the state-scoped claim inside sendWithRetry.
export async function sendNow(db: Db, id: string, by: string, now: Date = new Date()): Promise<EmailMessage | null> {
  const [message] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
  if (!message) throw new EngineError('message_not_found');
  if (INFLIGHT_OR_TERMINAL.includes(message.state)) return message;

  await db.update(emailMessages).set({ approvedBy: by, approvedAt: now }).where(eq(emailMessages.id, id));
  return sendWithRetry(db, id);
}

// The cron-facing sweep (Task 4 calls this on a timer; this task just
// builds it). Picks up every 'scheduled' message whose computed send time
// has passed and sends it. Idempotent by construction: claimAndSend's
// state-scoped UPDATE means two overlapping executeDue() calls (or a tick
// racing an admin's Send now) can each only claim a message that's STILL
// 'scheduled' at the moment their own claim runs.
export async function executeDue(db: Db, now: Date = new Date()): Promise<EmailMessage[]> {
  const settingsRow = await getSettings(db);
  const candidates = await db.select().from(emailMessages).where(eq(emailMessages.state, 'scheduled'));
  const sent: EmailMessage[] = [];

  for (const message of candidates) {
    if (!message.meetingId) continue;
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, message.meetingId));
    if (!meeting) continue;
    const scheduledAt = scheduledTimeFor(message, meeting.meetingDate, settingsRow);
    if (now < scheduledAt) continue;

    const result = await claimAndSend(db, message.id);
    if (result) sent.push(result);
  }

  return sent;
}

// Atomically claims a 'scheduled' message into 'sending' before sending —
// the actual structural double-send guard for the scheduled path.
async function claimAndSend(db: Db, id: string): Promise<EmailMessage | null> {
  const [claimed] = await db.update(emailMessages)
    .set({ state: 'sending', sendingAt: new Date() })
    .where(and(eq(emailMessages.id, id), eq(emailMessages.state, 'scheduled')))
    .returning();
  if (!claimed) return null;
  return sendWithRetry(db, id, claimed);
}

// Shared claim for approve()-after-time and sendNow(): moves the message
// into 'sending' from whatever pre-send state it's in, guarded the same
// way as claimAndSend so two simultaneous callers (e.g. an impatient
// double-click) can't both win.
async function claimFromAnyPreSendState(db: Db, id: string): Promise<EmailMessage | null> {
  const [claimed] = await db.update(emailMessages)
    .set({ state: 'sending', sendingAt: new Date() })
    .where(and(eq(emailMessages.id, id), notInArray(emailMessages.state, INFLIGHT_OR_TERMINAL)))
    .returning();
  return claimed ?? null;
}

function toSendable(message: EmailMessage): SendableMessage {
  return {
    type: message.type,
    sendKey: message.sendKey,
    recipients: message.recipients,
    subject: message.subject,
    html: message.bodySnapshot ?? '',
  };
}

// Up to MAX_ATTEMPTS immediate attempts against send.ts before giving up.
// No artificial delay between attempts. CORRECTION (Task 4 review): a
// message left 'failed' here is NOT automatically retried by any future
// cron tick — Task 4's lib/emails/tick.ts / executeDue only ever claims
// messages in state 'scheduled', never 'failed'. The only paths back to
// life for a failed row are an admin's manual Send now (Task 5's UI,
// sendNow() below) or a fresh send_key (a new meeting). This loop only
// covers "the transient blip resolved within the same call", which is
// what spec §16's "retry after transient failure doesn't duplicate" is
// checking for. Every outcome is written exactly once, after the loop —
// a mid-loop failure never touches the DB, so a fails-twice-then-succeeds
// run leaves no failed rows behind at all.
async function sendWithRetry(db: Db, id: string, alreadyClaimed?: EmailMessage): Promise<EmailMessage | null> {
  const claimed = alreadyClaimed ?? await claimFromAnyPreSendState(db, id);
  if (!claimed) return null;

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await sendEmailMessage(toSendable(claimed));
      const [updated] = await db.update(emailMessages)
        .set({ state: 'sent', sentAt: new Date(), providerMessageId: result.providerMessageId, error: null })
        .where(eq(emailMessages.id, id))
        .returning();
      return updated;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const [failed] = await db.update(emailMessages)
    .set({ state: 'failed', error: `Failed after ${MAX_ATTEMPTS} attempts: ${lastError}` })
    .where(eq(emailMessages.id, id))
    .returning();
  return failed;
}

const STALE_SENDING_MINUTES = 10;

// P2-3 review carry-in: the crash-mid-send recovery the engine otherwise
// lacks. A message stuck in 'sending' (the process died between claiming it
// and recording sent/failed) would hold that state forever — both claim
// guards above (claimAndSend, claimFromAnyPreSendState) deliberately
// EXCLUDE 'sending' from what they'll (re)claim, precisely so two live
// attempts can never overlap. That correctness property becomes a
// liability without a reaper: nothing would ever pick the row back up.
// Reclaiming it into 'failed' (not straight back to 'scheduled' — a
// send attempt may have actually reached Resend before the crash;
// 'failed' surfaces it for a deliberate manual retry via sendNow, the
// ONLY retry path a reclaimed row has — see the CORRECTION comment on
// sendWithRetry above: no cron tick auto-retries a 'failed' row) rather
// than silently re-attempting. error='stale-reclaimed' distinguishes
// this from a real Resend failure in the dashboard/logs.
//
// The WHERE clause (state='sending' AND (sendingAt older than the cutoff
// OR sendingAt IS NULL)) IS the state-guard the task calls for: two
// overlapping reaper calls (or a reaper racing a send that legitimately
// finishes mid-sweep) can each only reclaim a row that is STILL 'sending'
// with a STILL-stale/null sendingAt at the moment their own UPDATE runs —
// a row that already resolved to sent/failed between read and write
// matches zero rows for the loser. The `OR isNull(sendingAt)` half (M1
// review) exists for rows that entered 'sending' before migration 0002
// added the column — those have no age to compare against at all, so
// "unknown age" is treated the same as "definitely stale" rather than
// being silently unreachable forever.
export async function reapStaleSending(db: Db, now: Date = new Date()): Promise<EmailMessage[]> {
  const staleBefore = new Date(now.getTime() - STALE_SENDING_MINUTES * 60_000);
  return db.update(emailMessages)
    .set({ state: 'failed', error: 'stale-reclaimed' })
    .where(and(
      eq(emailMessages.state, 'sending'),
      or(lt(emailMessages.sendingAt, staleBefore), isNull(emailMessages.sendingAt)),
    ))
    .returning();
}

// P2-3 review carry-in: while approve-mode is on, Jason gets exactly one
// "drafts ready to approve" email per meeting — fired by the cron tick
// (lib/emails/tick.ts) the first time it finds this meeting's drafts
// sitting in 'awaiting_approval'. Idempotency mirrors createDrafts' own
// pattern exactly: an INSERT ... ON CONFLICT DO NOTHING on send_key
// (approvalNoticeSendKey) is the ONLY thing standing between "never sent"
// and "sent" — if the insert is a no-op (a previous tick already created
// this row, whether it went on to send, fail, or is still in flight), this
// call is a no-op too. There is deliberately no separate "already sent?"
// check: the insert's own uniqueness IS the check, and doing it any other
// way would reopen a window for two overlapping ticks to both decide
// "not yet sent" and both fire.
//
// approveMode OFF short-circuits before touching the DB at all — nothing
// ever sits in 'awaiting_approval' in that mode, so there is nothing to
// notify about.
export async function ensureApprovalNotice(db: Db, meetingId: string): Promise<EmailMessage | null> {
  const settingsRow = await getSettings(db);
  if (!settingsRow.approveMode) return null;

  const [awaitingApproval] = await db.select({ id: emailMessages.id }).from(emailMessages)
    .where(and(eq(emailMessages.meetingId, meetingId), eq(emailMessages.state, 'awaiting_approval')))
    .limit(1);
  if (!awaitingApproval) return null;

  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!meeting) throw new EngineError('meeting_not_found');
  const meetingDateLabel = formatMeetingDateLabel(meeting.meetingDate);

  const [inserted] = await db.insert(emailMessages).values({
    sendKey: approvalNoticeSendKey(meetingId),
    type: 'approval_notice',
    meetingId,
    recipients: [OWNER_EMAIL],
    subject: approvalNoticeSubject(meetingDateLabel),
    bodySnapshot: approvalNoticeHtml({ meetingDateLabel, siteUrl: siteUrl() }),
    state: 'draft',
  }).onConflictDoNothing({ target: emailMessages.sendKey }).returning();

  if (!inserted) return null; // already created by an earlier tick — never re-fire
  return sendWithRetry(db, inserted.id);
}

// Phase 2 Task 6: the owner notification fired the first time a given RSVP/
// interest token's /rsvp/[token] link is opened — "{fullName} plans to
// visit Wednesday" or "{fullName} is interested in membership" depending on
// the token's purpose. Called from lib/rsvp-visit.ts, which is itself only
// invoked once markRsvpTokenUsed's own atomically-guarded column update
// (lib/emails/rsvp-tokens.ts) confirms THIS call is the one that won first
// use — send_key uniqueness here is a second, independent guard on top of
// that, not the only one (see rsvpNoticeSendKey's own comment). No
// meetingId: like weekly_export, a token outlives any single meeting's
// compile, so there's nothing meeting-scoped to attach this row to.
export async function ensureRsvpNotice(
  db: Db,
  { token, purpose, personFullName }: { token: string; purpose: RsvpNoticePurpose; personFullName: string },
): Promise<EmailMessage | null> {
  const [inserted] = await db.insert(emailMessages).values({
    sendKey: rsvpNoticeSendKey(token),
    type: 'rsvp_notice',
    recipients: [OWNER_EMAIL],
    subject: rsvpNoticeSubject(purpose, personFullName),
    bodySnapshot: rsvpNoticeHtml({ purpose, personFullName, siteUrl: siteUrl() }),
    state: 'draft',
  }).onConflictDoNothing({ target: emailMessages.sendKey }).returning();

  if (!inserted) return null; // already created — never re-fire for the same token
  return sendWithRetry(db, inserted.id);
}
