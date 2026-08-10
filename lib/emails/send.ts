// The single choke point every outbound email passes through — whether
// it's a visitor thank-you, the leadership report, or an admin "Send now"
// click, it ends up here. Two things are enforced in exactly ONE place so
// no future call site can forget to re-implement them: SAFE_MODE recipient
// redirection, and the ICS calendar attachment on visitor emails.
//
// Otherwise deliberately NO database access here — lib/emails/engine.ts
// still owns every email_messages state transition (including recording
// providerMessageId on success and the error on exhausted retries). The one
// exception, as of migration 0008, is isSafeModeActive's OPTIONAL settings
// lookup below: when a caller has a `db` handle to thread through, safe
// mode can be overridden from settings.email_safe_mode instead of only the
// env var. That's a single read-only SELECT against one singleton row, not
// a new dependency on the rest of the app's data model — sendEmailMessage's
// only WRITE-side effect is still just the Resend fetch, which keeps it
// cheap to test by mocking global.fetch alone. Fetch pattern matches
// lib/auth-config.ts's sendVerificationRequest (raw fetch to Resend's REST
// API, not the `resend` SDK — same convention as the rest of this app's
// auth emails).

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { settings as settingsTable } from '@/db/schema';
import type { Db } from '@/lib/db';
import { generateMeetingIcs } from './ics';
import { OWNER_EMAIL } from './constants';

export type SendableMessage = {
  type: 'leadership_report' | 'visitor_thankyou' | 'approval_notice' | 'weekly_export' | 'rsvp_notice';
  sendKey: string;
  recipients: string[];
  subject: string;
  html: string;
  text?: string | null;
  // Explicit attachments override the type-based default below (only
  // visitor_thankyou auto-attaches a calendar invite) — used by the weekly
  // export (lib/emails/export.ts), whose JSON dump isn't tied to any
  // calendar event and has nothing to do with icsAttachment().
  attachments?: Array<{ filename: string; content: string }>;
};

export type SendResult = { providerMessageId: string };

export class SendError extends Error {}

const RESEND_DEV_FALLBACK = 'onboarding@resend.dev';
const RESEND_API_URL = 'https://api.resend.com/emails';

// EMAIL_SAFE_MODE follows the plan's "default ON until Jason flips it"
// posture: absence of the env var, or any value other than the literal
// string '0', is treated as ON. A typo'd or unset env var fails SAFE, never
// fails OPEN — the only direction that matters before Resend domain
// verification is real.
function envSaysSafeMode(): boolean {
  return process.env.EMAIL_SAFE_MODE !== '0';
}

// Belt-and-suspenders: even if EMAIL_SAFE_MODE were somehow '0', sending
// FROM the shared resend.dev fallback (rather than a verified
// bni@amplysystems.com sender) means Resend itself will only ever deliver
// to the account owner anyway — and a real visitor email arriving from a
// generic onboarding@resend.dev sender would look broken regardless. Force
// safe mode on whenever EMAIL_FROM hasn't been switched to a real sender
// yet, independent of the env flag's value.
function fromIsUnverifiedFallback(): boolean {
  const from = process.env.EMAIL_FROM ?? RESEND_DEV_FALLBACK;
  return from.includes(RESEND_DEV_FALLBACK);
}

// Migration 0008: settings.email_safe_mode (nullable — NULL means "no
// admin has touched the toggle yet, keep following the env default").
// Isolated into its own helper so isSafeModeActive's own control flow below
// stays readable; returns null (not false) on "no row" or "row exists but
// column is null" so the caller can tell "no override" from "override is
// explicitly off."
async function settingsSafeModeOverride(db: Db): Promise<boolean | null> {
  const [row] = await db.select({ emailSafeMode: settingsTable.emailSafeMode })
    .from(settingsTable).where(eq(settingsTable.id, 1));
  return row?.emailSafeMode ?? null;
}

// Exported (not just an internal helper of applySafeMode below) so
// app/api/admin/emails' GET can report `safeMode` to the admin UI — the
// email center shows a banner ("Test mode is on…") whenever this is true,
// since otherwise an admin watching "Sent" chips has no way to tell a real
// send from one that got silently redirected to the owner's own inbox.
//
// `db` is OPTIONAL: pass it (from any call site that has a db handle — the
// engine send path, lib/emails/export.ts) to let an explicit
// settings.email_safe_mode override win over the env default; omit it (the
// env-only overload — e.g. this module's own applySafeMode below, when
// sendEmailMessage is called with no db) to fall back to the exact
// pre-migration-0008 env-only behavior. Either way, the fromIsUnverified-
// Fallback() belt-and-suspenders guard is checked FIRST and always wins,
// even over an explicit `false` override — see that function's own comment
// for why sending from an unverified test sender can never be allowed to
// reach real people, no matter what any toggle says.
export async function isSafeModeActive(db?: Db): Promise<boolean> {
  if (fromIsUnverifiedFallback()) return true;
  if (db) {
    const override = await settingsSafeModeOverride(db);
    if (override !== null) return override;
  }
  return envSaysSafeMode();
}

async function applySafeMode(message: SendableMessage, db?: Db): Promise<SendableMessage> {
  if (!(await isSafeModeActive(db))) return message;
  const original = message.recipients.join(', ');
  return {
    ...message,
    recipients: [OWNER_EMAIL],
    subject: `[SAFE→${original}] ${message.subject}`,
  };
}

function icsAttachment(now: Date): { filename: string; content: string } {
  const ics = generateMeetingIcs({ now });
  return { filename: 'bni-wheeling-meeting.ics', content: Buffer.from(ics, 'utf-8').toString('base64') };
}

export async function sendEmailMessage(
  message: SendableMessage, now: Date = new Date(), db?: Db,
): Promise<SendResult> {
  const safed = await applySafeMode(message, db);
  // Both visitor email variants (v1 thank-you and v2 conversion) get the
  // invite attached automatically — the leadership report, approval
  // notice, and weekly export don't. An explicit `attachments` (weekly
  // export's JSON dump) always wins over this default.
  const attachments = message.attachments
    ?? (message.type === 'visitor_thankyou' ? [icsAttachment(now)] : undefined);

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AUTH_RESEND_KEY}`,
      'Content-Type': 'application/json',
      // Stable across every retry attempt for this message (it's the
      // email_messages.send_key, not per-attempt) — if a request times out
      // AFTER Resend already accepted it, the retry in
      // lib/emails/engine.ts's sendWithRetry dedupes at Resend instead of
      // actually double-delivering to the recipient.
      'Idempotency-Key': message.sendKey,
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? RESEND_DEV_FALLBACK,
      to: safed.recipients,
      subject: safed.subject,
      html: safed.html,
      text: safed.text ?? undefined,
      replyTo: OWNER_EMAIL,
      ...(attachments ? { attachments } : {}),
    }),
  });

  if (!res.ok) {
    throw new SendError(`Resend send failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new SendError('Resend response missing message id');
  return { providerMessageId: data.id };
}

export type TestEmailInput = { to: string; subject: string; html: string; text?: string | null };

// Admin "Test Lab" (System test section) send path — deliberately a SEPARATE
// function from sendEmailMessage above, not a variant/flag on it. This is
// test infrastructure, not the production pipeline: it never touches
// email_messages, never goes through lib/emails/engine.ts's state machine,
// and never runs applySafeMode — a Test Lab send is ALWAYS addressed to
// exactly the admin's own session email (app/api/admin/test-lab/route.ts
// resolves `to` from requireAdmin()'s guard, never from client input), so
// there's nothing for safe mode to redirect it away from. The '[TEST] '
// subject prefix is the one thing that distinguishes it in an inbox from a
// real send.
export async function sendTestEmail({ to, subject, html, text }: TestEmailInput): Promise<SendResult> {
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AUTH_RESEND_KEY}`,
      'Content-Type': 'application/json',
      // A fresh key per call, unlike sendEmailMessage's stable send_key
      // above — repeat Test Lab sends are SUPPOSED to each land as their
      // own email (clicking "Send me Visit 1" twice should produce two
      // emails, not one deduped by Resend), so nothing here should ever
      // collide. Still set, per the same fetch/Idempotency-Key convention
      // as every other Resend request this module makes, so a single
      // request that times out after Resend already accepted it doesn't
      // get blindly retried into a double-send by any future retry wrapper
      // added around this function.
      'Idempotency-Key': `test-email:${randomUUID()}`,
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? RESEND_DEV_FALLBACK,
      to: [to],
      subject: `[TEST] ${subject}`,
      html,
      text: text ?? undefined,
      replyTo: OWNER_EMAIL,
    }),
  });

  if (!res.ok) {
    throw new SendError(`Resend send failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new SendError('Resend response missing message id');
  return { providerMessageId: data.id };
}
