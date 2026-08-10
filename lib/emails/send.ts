// The single choke point every outbound email passes through — whether
// it's a visitor thank-you, the leadership report, or (later) an admin
// "Send now" click, it ends up here. Two things are enforced in exactly
// ONE place so no future call site can forget to re-implement them:
// SAFE_MODE recipient redirection, and the ICS calendar attachment on
// visitor emails.
//
// Deliberately NO database access here — lib/emails/engine.ts owns every
// email_messages state transition (including recording providerMessageId
// on success and the error on exhausted retries). Keeping this module
// DB-free means its only side effect is the Resend fetch, which keeps it
// cheap to test by mocking global.fetch alone. Fetch pattern matches
// lib/auth-config.ts's sendVerificationRequest (raw fetch to Resend's REST
// API, not the `resend` SDK — same convention as the rest of this app's
// auth emails).

import { generateMeetingIcs } from './ics';
import { OWNER_EMAIL } from './constants';

export type SendableMessage = {
  type: 'leadership_report' | 'visitor_thankyou';
  recipients: string[];
  subject: string;
  html: string;
  text?: string | null;
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

export function isSafeModeOn(): boolean {
  return envSaysSafeMode() || fromIsUnverifiedFallback();
}

function applySafeMode(message: SendableMessage): SendableMessage {
  if (!isSafeModeOn()) return message;
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

export async function sendEmailMessage(message: SendableMessage, now: Date = new Date()): Promise<SendResult> {
  const safed = applySafeMode(message);
  // Both visitor email variants (v1 thank-you and v2 conversion) get the
  // invite attached — the leadership report doesn't need one.
  const attachments = message.type === 'visitor_thankyou' ? [icsAttachment(now)] : undefined;

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.AUTH_RESEND_KEY}`,
      'Content-Type': 'application/json',
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
