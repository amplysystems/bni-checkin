// Phase 2 Task 7: Resend delivery webhooks (Svix-signed). Handles signature
// verification, idempotent event storage, and forward-only delivery-status
// mapping onto the matching email_messages row — see spec §7.
//
// Deliberately no `svix` package dependency (the plan calls for
// node:crypto only) — the scheme itself is simple and documented at
// https://docs.svix.com/receiving/verifying-payloads/how-manual: the signed
// content is `${svix-id}.${svix-timestamp}.${body}`, HMAC-SHA256'd with the
// secret's base64 payload AFTER stripping the `whsec_` prefix, base64
// re-encoded, and compared (constant-time) against every `v1,...` candidate
// in svix-signature (Svix rotates signing keys, so more than one candidate
// can legitimately be present at once).
//
// Kept in lib/ (not inline in the route) so it's unit-testable without
// constructing a real Request — same split as lib/emails/tick.ts and its
// thin app/api/cron/email-tick/route.ts wrapper.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { emailEvents, emailMessages } from '@/db/schema';
import type { Db } from '@/lib/db';

// Resend delivery is at-least-once and may arrive out of order (spec §7) —
// this is the tolerance window for the signed timestamp, not a delivery
// SLA. A request outside this window is rejected the same as a bad
// signature (401): an old signed payload replayed by an attacker is
// cryptographically valid but must not be honored indefinitely.
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

// Unset RESEND_WEBHOOK_SECRET fails closed with 501, not 401 — same
// "not configured" vs. "someone's guessing at credentials" distinction as
// lib/cron-guard.ts's requireCronSecret, which this mirrors deliberately.
// Controller sets this env var only after Jason creates the webhook in
// Resend pointing at the live URL; until then the route is a documented
// no-op rather than a live endpoint rejecting every real Resend request.
export function requireResendWebhookSecret(): string | Response {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: 'webhook_secret_unset' }, { status: 501 });
  return secret;
}

export type SvixHeaders = { id: string | null; timestamp: string | null; signature: string | null };

// Exported for direct unit testing (tests/webhooks.test.ts) independent of
// constructing a full Request/Response round trip.
export function verifySvixSignature(
  headers: SvixHeaders,
  body: string,
  secret: string,
  now: Date = new Date(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const skewSeconds = Math.abs(now.getTime() / 1000 - timestampSeconds);
  if (skewSeconds > TIMESTAMP_TOLERANCE_SECONDS) return false;

  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  } catch {
    return false;
  }
  if (secretBytes.length === 0) return false;

  // Compared as the base64-encoded STRING (utf-8 bytes), not decoded back
  // to raw digest bytes on either side — this is what Svix's own reference
  // verifiers do, and it's what keeps `expected` and each `candidate`
  // directly comparable: both are base64 text at this point, and decoding
  // only one of them would compare unrelated byte lengths.
  const expected = createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  const expectedBuf = Buffer.from(expected, 'utf8');

  // svix-signature is space-delimited "v1,<base64sig>" candidates — compare
  // against every one (constant-time per candidate; an early-exit `===`
  // would leak how many leading bytes matched via timing).
  return signature
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter((v): v is string => Boolean(v))
    .some((candidate) => {
      const candidateBuf = Buffer.from(candidate, 'utf8');
      return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
    });
}

const WebhookBody = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z.object({ email_id: z.string().optional() }).passthrough().optional(),
});

export type DeliveryStatus = 'sent' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed';

// Only the six Resend event types spec §7 / db/schema.ts's check constraint
// name — anything else (email.opened, email.clicked, email.scheduled, …)
// is still stored in email_events (below) but doesn't move
// email_messages.delivery_status, since there's no corresponding status.
const EVENT_TYPE_TO_DELIVERY_STATUS: Record<string, DeliveryStatus> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

// Forward-only progression (spec §7 / plan Task 7): an incoming status only
// lands if it outranks whatever's already stored (a NULL current status
// always loses, so the very first event always wins). 'sent' is the
// earliest signal; 'delayed' is a transient in-between; 'delivered' and the
// three terminal negative outcomes share the top rank — once any one of
// them lands, none of the others (nor a stale re-delivery of an earlier
// rank, e.g. a duplicated 'sent' arriving after 'delivered') can overwrite
// it. This is what makes "delivered never regresses to sent" true even
// under Resend's documented at-least-once, out-of-order delivery.
const DELIVERY_STATUS_RANK: Record<DeliveryStatus, number> = {
  sent: 1,
  delayed: 2,
  delivered: 3,
  bounced: 3,
  complained: 3,
  failed: 3,
};

// The CASE expression reads the CURRENT stored value; the new value's rank
// is a plain JS number baked into the query as a parameter. A single
// guarded UPDATE (no separate read-then-write) — two concurrent webhook
// deliveries for the same message serialize on Postgres' normal per-row
// write lock, so the loser's own predicate is evaluated against the
// winner's already-committed value, never a stale read.
const CURRENT_RANK_SQL = sql`CASE ${emailMessages.deliveryStatus}
  WHEN 'sent' THEN 1
  WHEN 'delayed' THEN 2
  WHEN 'delivered' THEN 3
  WHEN 'bounced' THEN 3
  WHEN 'complained' THEN 3
  WHEN 'failed' THEN 3
  ELSE 0
END`;

async function applyDeliveryStatusForwardOnly(
  db: Db,
  providerMessageId: string,
  status: DeliveryStatus,
): Promise<boolean> {
  const [updated] = await db.update(emailMessages)
    .set({ deliveryStatus: status })
    .where(and(
      eq(emailMessages.providerMessageId, providerMessageId),
      sql`${CURRENT_RANK_SQL} < ${DELIVERY_STATUS_RANK[status]}`,
    ))
    .returning({ id: emailMessages.id });
  return updated !== undefined;
}

export type WebhookOutcome = {
  duplicate: boolean;
  messageMatched: boolean;
  messageUpdated: boolean;
};

// The whole verified-and-parsed pipeline: idempotent insert into
// email_events on providerEventId (svix-id) via onConflictDoNothing, then —
// only for a genuinely new event, never a replay — the forward-only
// delivery_status update on the matching email_messages row (matched by
// providerMessageId = data.email_id). An unmatched email_id still records
// the event (audit trail intact) and simply updates nothing else.
export async function recordResendWebhookEvent(
  db: Db,
  { eventId, body, now = new Date() }: { eventId: string; body: z.infer<typeof WebhookBody>; now?: Date },
): Promise<WebhookOutcome> {
  const emailId = body.data?.email_id;

  let matchedMessageId: string | null = null;
  if (emailId) {
    const [found] = await db.select({ id: emailMessages.id }).from(emailMessages)
      .where(eq(emailMessages.providerMessageId, emailId));
    matchedMessageId = found?.id ?? null;
  }

  const parsedCreatedAt = body.created_at ? new Date(body.created_at) : null;
  const occurredAt = parsedCreatedAt && !Number.isNaN(parsedCreatedAt.getTime()) ? parsedCreatedAt : now;

  const [inserted] = await db.insert(emailEvents).values({
    providerEventId: eventId,
    messageId: matchedMessageId,
    eventType: body.type,
    occurredAt,
    payload: body,
  }).onConflictDoNothing({ target: emailEvents.providerEventId }).returning({ id: emailEvents.id });

  if (!inserted) {
    // Already recorded by an earlier delivery of the SAME event — Resend's
    // at-least-once guarantee means this is expected, not an error. Never
    // re-apply the status update either: whatever the first delivery did
    // (or the forward-only guard refused to do) stands.
    return { duplicate: true, messageMatched: matchedMessageId !== null, messageUpdated: false };
  }

  const deliveryStatus = EVENT_TYPE_TO_DELIVERY_STATUS[body.type];
  let messageUpdated = false;
  if (matchedMessageId && emailId && deliveryStatus) {
    messageUpdated = await applyDeliveryStatusForwardOnly(db, emailId, deliveryStatus);
  }

  return { duplicate: false, messageMatched: matchedMessageId !== null, messageUpdated };
}

// The full route handler, split out from app/api/webhooks/resend/route.ts
// so it's directly callable from tests without needing Next.js' route
// module resolution. Returns a Response in every case — 501 (secret
// unset), 401 (missing/invalid signature or stale timestamp), 400
// (malformed body, but ONLY after signature verification — an attacker
// without the secret gets 401 regardless of what garbage they send as a
// body), or 200.
export async function handleResendWebhook(db: Db, req: Request, now: Date = new Date()): Promise<Response> {
  const secret = requireResendWebhookSecret();
  if (secret instanceof Response) return secret;

  const rawBody = await req.text();
  const headers: SvixHeaders = {
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
  };

  // No detail in the error body on any auth failure (plan: "Invalid →
  // 400/401 (no detail)") — a generic code, never the underlying
  // crypto/parse reason, so a prober learns nothing about why a guess
  // failed.
  if (!verifySvixSignature(headers, rawBody, secret, now)) {
    return Response.json({ error: 'invalid' }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'invalid' }, { status: 400 });
  }
  const parsed = WebhookBody.safeParse(json);
  if (!parsed.success) return Response.json({ error: 'invalid' }, { status: 400 });

  const outcome = await recordResendWebhookEvent(db, { eventId: headers.id!, body: parsed.data, now });
  return Response.json({ ok: true, ...outcome });
}
