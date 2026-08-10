import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/auth';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { emailEvents, emailMessages } from '@/db/schema';
import { setDb } from '@/lib/db';
import { registerVisitor } from '@/lib/visitors';
import { verifySvixSignature } from '@/lib/emails/webhook';
import { POST as webhookPOST } from '@/app/api/webhooks/resend/route';
import { GET as rosterGET } from '@/app/api/admin/roster/route';

const mockAuth = vi.mocked(auth);
const asAdmin = () => mockAuth.mockResolvedValue(
  { user: { email: 'barriosj4@gmail.com' } } as unknown as Awaited<ReturnType<typeof auth>>,
);

// A plausible-looking whsec_ secret — its actual base64 payload is
// arbitrary test material, decoded exactly the way lib/emails/webhook.ts
// decodes any other RESEND_WEBHOOK_SECRET value.
const SECRET = `whsec_${Buffer.from('test-signing-secret-material').toString('base64')}`;

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const digest = createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${digest}`;
}

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `evt_test_${eventCounter}`;
}

function nowTimestampSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}

type WebhookPayload = { type: string; created_at?: string; data?: Record<string, unknown> };

function req({
  id = nextEventId(),
  timestamp = nowTimestampSeconds(),
  secret = SECRET,
  body,
  badSignature = false,
  omitSignature = false,
}: {
  id?: string;
  timestamp?: string;
  secret?: string;
  body: WebhookPayload | string;
  badSignature?: boolean;
  omitSignature?: boolean;
}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  headers['svix-id'] = id;
  headers['svix-timestamp'] = timestamp;
  if (!omitSignature) {
    headers['svix-signature'] = badSignature ? 'v1,not-a-real-signature' : sign(secret, id, timestamp, bodyStr);
  }
  return new Request('http://webhook.test/api/webhooks/resend', { method: 'POST', headers, body: bodyStr });
}

describe('POST /api/webhooks/resend', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    setDb(db);
    vi.stubEnv('RESEND_WEBHOOK_SECRET', SECRET);
    eventCounter = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('501s when RESEND_WEBHOOK_SECRET is unset', async () => {
    vi.stubEnv('RESEND_WEBHOOK_SECRET', undefined);
    const res = await webhookPOST(req({ body: { type: 'email.sent', data: { email_id: 'x' } } }));
    expect(res.status).toBe(501);
  });

  it('401s on a bad signature', async () => {
    const res = await webhookPOST(req({ body: { type: 'email.sent', data: { email_id: 'x' } }, badSignature: true }));
    expect(res.status).toBe(401);
    expect(await db.select().from(emailEvents)).toHaveLength(0);
  });

  it('401s when the signature header is missing entirely', async () => {
    const res = await webhookPOST(req({ body: { type: 'email.sent', data: { email_id: 'x' } }, omitSignature: true }));
    expect(res.status).toBe(401);
  });

  it('401s when the signature was computed with the wrong secret', async () => {
    const otherSecret = `whsec_${Buffer.from('a-different-secret').toString('base64')}`;
    const res = await webhookPOST(req({ body: { type: 'email.sent', data: { email_id: 'x' } }, secret: otherSecret }));
    expect(res.status).toBe(401);
  });

  it('401s (rejects) a stale timestamp outside the 5-minute skew tolerance', async () => {
    const staleTimestamp = Math.floor((Date.now() - 10 * 60_000) / 1000).toString();
    const res = await webhookPOST(req({
      timestamp: staleTimestamp, body: { type: 'email.sent', data: { email_id: 'x' } },
    }));
    expect(res.status).toBe(401);
    expect(await db.select().from(emailEvents)).toHaveLength(0);
  });

  it('400s on a body that fails validation after a VALID signature (proves signature is checked first)', async () => {
    // Sign the literal string below (not valid JSON) with the real secret —
    // the signature is genuinely valid for this exact body, so a 400 here
    // (not a 401) proves body validation runs only after signature
    // verification passes.
    const res = await webhookPOST(req({ body: 'not-json-at-all' }));
    expect(res.status).toBe(400);
  });

  it('valid event: stores an email_events row and updates the matching message\'s deliveryStatus', async () => {
    const [message] = await db.insert(emailMessages).values({
      sendKey: 'webhook-test:leadership_report', type: 'leadership_report', meetingId: null,
      recipients: ['x@example.com'], subject: 'x', state: 'sent', providerMessageId: 'resend-msg-1',
    }).returning();

    const eventId = nextEventId();
    const res = await webhookPOST(req({
      id: eventId,
      body: { type: 'email.delivered', created_at: '2026-08-12T22:03:00.000Z', data: { email_id: 'resend-msg-1' } },
    }));
    expect(res.status).toBe(200);

    const events = await db.select().from(emailEvents).where(eq(emailEvents.providerEventId, eventId));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('email.delivered');
    expect(events[0].messageId).toBe(message.id);
    expect(events[0].occurredAt.toISOString()).toBe('2026-08-12T22:03:00.000Z');
    expect(events[0].payload).toBeTruthy();

    const [updated] = await db.select().from(emailMessages).where(eq(emailMessages.id, message.id));
    expect(updated.deliveryStatus).toBe('delivered');
  });

  it('duplicate svix-id: second delivery of the same event is a no-op — single row, no error', async () => {
    await db.insert(emailMessages).values({
      sendKey: 'webhook-test:dup', type: 'leadership_report', meetingId: null,
      recipients: ['x@example.com'], subject: 'x', state: 'sent', providerMessageId: 'resend-msg-dup',
    });
    const eventId = nextEventId();
    const timestamp = nowTimestampSeconds();
    const body: WebhookPayload = { type: 'email.sent', data: { email_id: 'resend-msg-dup' } };

    const first = await webhookPOST(req({ id: eventId, timestamp, body }));
    expect(first.status).toBe(200);
    const second = await webhookPOST(req({ id: eventId, timestamp, body }));
    expect(second.status).toBe(200);

    const events = await db.select().from(emailEvents).where(eq(emailEvents.providerEventId, eventId));
    expect(events).toHaveLength(1);
  });

  it('P2-7 carry-in: a "bounced" event arriving after "delivered" flips the status (bounced now outranks delivered)', async () => {
    await db.insert(emailMessages).values({
      sendKey: 'webhook-test:delivered-then-bounced', type: 'visitor_thankyou', meetingId: null,
      recipients: ['x@example.com'], subject: 'x', state: 'sent', providerMessageId: 'resend-msg-dtb',
    });

    const deliveredRes = await webhookPOST(req({
      body: { type: 'email.delivered', data: { email_id: 'resend-msg-dtb' } },
    }));
    expect(deliveredRes.status).toBe(200);
    const [afterDelivered] = await db.select().from(emailMessages)
      .where(eq(emailMessages.providerMessageId, 'resend-msg-dtb'));
    expect(afterDelivered.deliveryStatus).toBe('delivered');

    const bouncedRes = await webhookPOST(req({
      body: { type: 'email.bounced', data: { email_id: 'resend-msg-dtb' } },
    }));
    expect(bouncedRes.status).toBe(200);
    const [afterBounced] = await db.select().from(emailMessages)
      .where(eq(emailMessages.providerMessageId, 'resend-msg-dtb'));
    expect(afterBounced.deliveryStatus).toBe('bounced'); // flips — bounced outranks delivered now

    // And a stale re-delivery of the earlier "delivered" event can't flip it back.
    const staleDeliveredRes = await webhookPOST(req({
      body: { type: 'email.delivered', data: { email_id: 'resend-msg-dtb' } },
    }));
    expect(staleDeliveredRes.status).toBe(200);
    const [afterStale] = await db.select().from(emailMessages)
      .where(eq(emailMessages.providerMessageId, 'resend-msg-dtb'));
    expect(afterStale.deliveryStatus).toBe('bounced');
  });

  it('P2-7 carry-in: a duplicate svix-id delivery RE-APPLIES the forward-only status update (heals a crash between the events insert and the status update)', async () => {
    await db.insert(emailMessages).values({
      sendKey: 'webhook-test:crash-window', type: 'leadership_report', meetingId: null,
      recipients: ['x@example.com'], subject: 'x', state: 'sent', providerMessageId: 'resend-msg-crash',
    });

    const eventId = nextEventId();
    const timestamp = nowTimestampSeconds();
    const body: WebhookPayload = { type: 'email.delivered', data: { email_id: 'resend-msg-crash' } };

    // Simulate the crash: the events row already exists (as if a prior
    // delivery got as far as the email_events insert) but the message's
    // deliveryStatus was NEVER actually applied.
    await db.insert(emailEvents).values({
      providerEventId: eventId, messageId: null, eventType: body.type, occurredAt: new Date(), payload: body,
    });
    const [beforeRedelivery] = await db.select().from(emailMessages)
      .where(eq(emailMessages.providerMessageId, 'resend-msg-crash'));
    expect(beforeRedelivery.deliveryStatus).toBeNull();

    // Resend's at-least-once redelivery of the SAME event arrives — under
    // the old early-return-on-duplicate logic this would be a permanent
    // no-op; it must now still apply the status.
    const res = await webhookPOST(req({ id: eventId, timestamp, body }));
    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody.duplicate).toBe(true); // still a duplicate event...
    expect(responseBody.messageUpdated).toBe(true); // ...but the status DID get applied this time

    const [afterRedelivery] = await db.select().from(emailMessages)
      .where(eq(emailMessages.providerMessageId, 'resend-msg-crash'));
    expect(afterRedelivery.deliveryStatus).toBe('delivered');

    // Still exactly one email_events row — the insert itself stayed a no-op.
    const events = await db.select().from(emailEvents).where(eq(emailEvents.providerEventId, eventId));
    expect(events).toHaveLength(1);
  });

  it('a genuine duplicate delivery of an ALREADY-APPLIED status is a true no-op (messageUpdated: false)', async () => {
    await db.insert(emailMessages).values({
      sendKey: 'webhook-test:already-applied', type: 'leadership_report', meetingId: null,
      recipients: ['x@example.com'], subject: 'x', state: 'sent', providerMessageId: 'resend-msg-applied',
    });
    const eventId = nextEventId();
    const timestamp = nowTimestampSeconds();
    const body: WebhookPayload = { type: 'email.delivered', data: { email_id: 'resend-msg-applied' } };

    const first = await webhookPOST(req({ id: eventId, timestamp, body }));
    expect((await first.json()).messageUpdated).toBe(true);

    const second = await webhookPOST(req({ id: eventId, timestamp, body }));
    const secondBody = await second.json();
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.messageUpdated).toBe(false); // already at that rank — nothing left to apply
  });

  it('out-of-order delivery: a "sent" event arriving after "delivered" does not regress the status', async () => {
    await db.insert(emailMessages).values({
      sendKey: 'webhook-test:ooo', type: 'leadership_report', meetingId: null,
      recipients: ['x@example.com'], subject: 'x', state: 'sent', providerMessageId: 'resend-msg-ooo',
    });

    const deliveredRes = await webhookPOST(req({
      body: { type: 'email.delivered', data: { email_id: 'resend-msg-ooo' } },
    }));
    expect(deliveredRes.status).toBe(200);

    const sentRes = await webhookPOST(req({
      body: { type: 'email.sent', data: { email_id: 'resend-msg-ooo' } },
    }));
    expect(sentRes.status).toBe(200);

    const [message] = await db.select().from(emailMessages).where(eq(emailMessages.providerMessageId, 'resend-msg-ooo'));
    expect(message.deliveryStatus).toBe('delivered'); // still delivered, never regressed to sent

    const events = await db.select().from(emailEvents);
    expect(events).toHaveLength(2); // both events recorded, even though only one moved the status
  });

  it('unknown email_id: the event is still stored, but no message is updated, and the response is 200', async () => {
    const eventId = nextEventId();
    const res = await webhookPOST(req({
      id: eventId, body: { type: 'email.delivered', data: { email_id: 'no-such-message-id' } },
    }));
    expect(res.status).toBe(200);

    const [event] = await db.select().from(emailEvents).where(eq(emailEvents.providerEventId, eventId));
    expect(event).toBeTruthy();
    expect(event.messageId).toBeNull();
  });

  it('bounce of a visitor thank-you surfaces emailBounced on the matching roster row', async () => {
    const NOW = new Date('2026-08-12T19:00:00Z');
    const { person } = await registerVisitor(db, {
      fullName: 'Bounced Visitor', industry: 'Roofing', company: null,
      email: 'bounced@example.com', phone: null, clientOpId: 'v-bounce-1', now: NOW,
    });
    await db.insert(emailMessages).values({
      sendKey: 'webhook-test:visitor-thankyou', type: 'visitor_thankyou', meetingId: null,
      recipients: [person.email!], subject: 'x', state: 'sent', providerMessageId: 'resend-msg-visitor-1',
    });

    vi.stubEnv('ADMIN_ALLOWLIST', 'barriosj4@gmail.com');
    asAdmin();
    const before = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    const beforePerson = before.people.find((p: { id: string }) => p.id === person.id);
    expect(beforePerson.emailBounced).toBe(false);

    const res = await webhookPOST(req({
      body: { type: 'email.bounced', data: { email_id: 'resend-msg-visitor-1' } },
    }));
    expect(res.status).toBe(200);

    const after = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    const afterPerson = after.people.find((p: { id: string }) => p.id === person.id);
    expect(afterPerson.emailBounced).toBe(true);

    // Someone else on the roster is unaffected.
    const jason = after.people.find((p: { fullName: string }) => p.fullName === 'Jason Barrios');
    expect(jason.emailBounced).toBe(false);
  });
});

describe('lib/emails/webhook: verifySvixSignature (direct unit tests)', () => {
  const secretBytes = 'unit-test-secret';
  const secret = `whsec_${Buffer.from(secretBytes).toString('base64')}`;

  it('accepts a correctly signed payload within the timestamp tolerance', () => {
    const now = new Date('2026-08-12T22:00:00Z');
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const body = JSON.stringify({ type: 'email.sent' });
    const signature = sign(secret, 'evt-1', timestamp, body);
    expect(verifySvixSignature({ id: 'evt-1', timestamp, signature }, body, secret, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const now = new Date('2026-08-12T22:00:00Z');
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const signature = sign(secret, 'evt-1', timestamp, JSON.stringify({ type: 'email.sent' }));
    const tamperedBody = JSON.stringify({ type: 'email.bounced' });
    expect(verifySvixSignature({ id: 'evt-1', timestamp, signature }, tamperedBody, secret, now)).toBe(false);
  });

  it('accepts exactly at the 5-minute boundary and rejects just past it', () => {
    const now = new Date('2026-08-12T22:00:00Z');
    const body = JSON.stringify({ type: 'email.sent' });

    const atBoundary = Math.floor((now.getTime() - 5 * 60_000) / 1000).toString();
    const atBoundarySig = sign(secret, 'evt-1', atBoundary, body);
    expect(verifySvixSignature({ id: 'evt-1', timestamp: atBoundary, signature: atBoundarySig }, body, secret, now))
      .toBe(true);

    const pastBoundary = Math.floor((now.getTime() - 5 * 60_000 - 1000) / 1000).toString();
    const pastBoundarySig = sign(secret, 'evt-1', pastBoundary, body);
    expect(verifySvixSignature({ id: 'evt-1', timestamp: pastBoundary, signature: pastBoundarySig }, body, secret, now))
      .toBe(false);
  });

  it('rejects when any of the three svix headers is missing', () => {
    const now = new Date('2026-08-12T22:00:00Z');
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const body = JSON.stringify({ type: 'email.sent' });
    const signature = sign(secret, 'evt-1', timestamp, body);
    expect(verifySvixSignature({ id: null, timestamp, signature }, body, secret, now)).toBe(false);
    expect(verifySvixSignature({ id: 'evt-1', timestamp: null, signature }, body, secret, now)).toBe(false);
    expect(verifySvixSignature({ id: 'evt-1', timestamp, signature: null }, body, secret, now)).toBe(false);
  });
});
