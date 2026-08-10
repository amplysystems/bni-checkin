// Phase 2 admin "Test Lab" (System test section) — app/api/admin/test-lab's
// route contract. Same requireAdmin-mocking convention as
// tests/admin-emails.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/auth';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { setDb } from '@/lib/db';
import { emailMessages, rsvpTokens } from '@/db/schema';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { registerVisitor } from '@/lib/visitors';
import { POST as testLabPOST } from '@/app/api/admin/test-lab/route';

const mockAuth = vi.mocked(auth);
const ADMIN_EMAIL = 'barriosj4@gmail.com';
const asEmail = (email: string) => mockAuth.mockResolvedValue(
  { user: { email } } as unknown as Awaited<ReturnType<typeof auth>>,
);
const asAdmin = () => asEmail(ADMIN_EMAIL);
const asUnauthenticated = () => mockAuth.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof auth>>);

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://admin.test/api/admin/test-lab', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

function mockFetchOk(id = 'test-resend-1') {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id }), text: async () => '' });
}

describe('admin test-lab API (app/api/admin/test-lab)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    setDb(db);
    vi.stubEnv('ADMIN_ALLOWLIST', ADMIN_EMAIL);
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('401s when unauthenticated', async () => {
    asUnauthenticated();
    const res = await testLabPOST(post({ action: 'preview', kind: 'thankyou_v1' }));
    expect(res.status).toBe(401);
  });

  it('401s for a session email outside the admin allowlist', async () => {
    asEmail('not-an-admin@example.com');
    const res = await testLabPOST(post({ action: 'preview', kind: 'thankyou_v1' }));
    expect(res.status).toBe(401);
  });

  describe('action=preview', () => {
    beforeEach(() => asAdmin());

    it.each(['thankyou_v1', 'thankyou_v2', 'weekly_report', 'rsvp_page'] as const)(
      'returns HTML for kind=%s with no send and no db writes',
      async (kind) => {
        const before = await db.select().from(emailMessages);
        const fetchMock = mockFetchOk();
        vi.stubGlobal('fetch', fetchMock);

        const res = await testLabPOST(post({ action: 'preview', kind }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(typeof body.subject).toBe('string');
        expect(typeof body.html).toBe('string');
        expect(body.html.length).toBeGreaterThan(0);

        expect(fetchMock).not.toHaveBeenCalled();
        const after = await db.select().from(emailMessages);
        expect(after).toHaveLength(before.length); // no counted rows created
      },
    );

    it('thankyou_v1 uses the SAMPLE visitor (Dana) and never a real recipient', async () => {
      const res = await testLabPOST(post({ action: 'preview', kind: 'thankyou_v1' }));
      const body = await res.json();
      expect(body.subject).toContain('Dana');
      expect(body.html).toContain('Dana');
    });

    it('thankyou_v2 uses the SAMPLE visitor\'s industry (CPA)', async () => {
      const res = await testLabPOST(post({ action: 'preview', kind: 'thankyou_v2' }));
      const body = await res.json();
      expect(body.subject).toContain('CPA');
    });

    it('weekly_report always renders the fully synthetic sample', async () => {
      const res = await testLabPOST(post({ action: 'preview', kind: 'weekly_report' }));
      const body = await res.json();
      expect(body.html).toContain('Sample Member 01');
      expect(body.html).toContain('18 / 25 active members');
    });

    // Regression guard (review fix): weekly_report used to reuse
    // compileForMeeting for "today's real meeting" when one existed with
    // attendance, which mints real rsvp_tokens rows for present visitors as
    // a side effect (see compileForMeeting's own header comment) — a real
    // write, contradicting the section's on-screen promise that these
    // actions "never change your data." It must now ALWAYS render the
    // synthetic sample and NEVER touch rsvp_tokens, even when a real
    // meeting with real attendance exists for today.
    it('weekly_report ignores a real meeting with attendance and never writes an rsvp_tokens row', async () => {
      const NOW = new Date('2026-08-12T19:00:00Z'); // Wednesday, 14:00 CT
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });

      await registerVisitor(db, {
        fullName: 'Real Visitor Today', industry: 'Roofing', company: null,
        email: 'real-visitor@example.com', phone: null, clientOpId: 'tl-real-1', now: NOW,
      });
      await getOrCreateMeetingFor(db, NOW);

      const tokensBefore = await db.select().from(rsvpTokens);
      const messagesBefore = await db.select().from(emailMessages);

      const res = await testLabPOST(post({ action: 'preview', kind: 'weekly_report' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.html).toContain('Sample Member 01'); // synthetic, not the real visitor
      expect(body.html).not.toContain('Real Visitor Today');

      const tokensAfter = await db.select().from(rsvpTokens);
      const messagesAfter = await db.select().from(emailMessages);
      expect(tokensAfter).toHaveLength(tokensBefore.length); // no rsvp_tokens minted
      expect(messagesAfter).toHaveLength(messagesBefore.length); // no email_messages written
    });

    it('rsvp_page never touches the database and renders a sample confirmation page', async () => {
      const res = await testLabPOST(post({ action: 'preview', kind: 'rsvp_page' }));
      const body = await res.json();
      expect(body.html).toContain('Dana');
      expect(body.html).toContain('Wednesday');
    });

    it('a client-supplied recipient in the body is silently ignored (the schema has no such field)', async () => {
      const res = await testLabPOST(post({
        action: 'preview', kind: 'thankyou_v1', to: 'someone-else@example.com',
      }));
      // Extra unknown fields don't break the request — zod's default mode
      // just ignores them; the point is there's no code path anywhere that
      // reads a `to` out of the preview body at all.
      expect(res.status).toBe(200);
    });

    it('rejects an unknown kind', async () => {
      const res = await testLabPOST(post({ action: 'preview', kind: 'not_a_real_kind' }));
      expect(res.status).toBe(400);
    });
  });

  describe('action=send', () => {
    beforeEach(() => asAdmin());

    it('sends exactly once, to the ADMIN\'s session email, with a [TEST] subject prefix', async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      const res = await testLabPOST(post({ action: 'send', kind: 'thankyou_v1' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: true });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toEqual([ADMIN_EMAIL]);
      expect(body.subject).toMatch(/^\[TEST\] /);
    });

    it('a client-supplied recipient is IGNORED — always the admin session email, never client input', async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      await testLabPOST(post({ action: 'send', kind: 'thankyou_v1', to: 'not-the-admin@example.com' }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toEqual([ADMIN_EMAIL]);
    });

    it('creates no email_messages row for a test send', async () => {
      vi.stubGlobal('fetch', mockFetchOk());
      const before = await db.select().from(emailMessages);
      await testLabPOST(post({ action: 'send', kind: 'weekly_report' }));
      const after = await db.select().from(emailMessages);
      expect(after).toHaveLength(before.length);
    });

    // Regression guard (review fix), mirroring the email_messages
    // zero-write assertion above — a weekly_report SEND must be just as
    // zero-write as its preview: no rsvp_tokens row, even with a real
    // meeting/attendance/visitor on the books for today.
    it('creates no rsvp_tokens row for a weekly_report test send, even with a real meeting on the books', async () => {
      const NOW = new Date('2026-08-12T19:00:00Z');
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      await registerVisitor(db, {
        fullName: 'Real Visitor Today', industry: 'Roofing', company: null,
        email: 'real-visitor-2@example.com', phone: null, clientOpId: 'tl-real-send-1', now: NOW,
      });
      await getOrCreateMeetingFor(db, NOW);

      vi.stubGlobal('fetch', mockFetchOk());
      const before = await db.select().from(rsvpTokens);
      const res = await testLabPOST(post({ action: 'send', kind: 'weekly_report' }));
      expect(res.status).toBe(200);
      const after = await db.select().from(rsvpTokens);
      expect(after).toHaveLength(before.length);
    });

    it('rejects rsvp_page for send (preview-only — there is no email to send)', async () => {
      const res = await testLabPOST(post({ action: 'send', kind: 'rsvp_page' }));
      expect(res.status).toBe(400);
    });

    it('sends even when safe mode is ON — a test send is independent of safe mode', async () => {
      vi.stubEnv('EMAIL_SAFE_MODE', '1');
      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      await testLabPOST(post({ action: 'send', kind: 'thankyou_v2' }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toEqual([ADMIN_EMAIL]); // not collapsed/redirected further by safe mode
      expect(body.subject).toMatch(/^\[TEST\] /);
    });

    // Rate limit: 20/hour/IP (lib/rate-limit.ts route 'test-email'). Freezes
    // Date the same way tests/kiosk-api.test.ts's rate-limit loops do, since
    // the route calls `new Date()` directly with no injectable `now`.
    it('enforces the 20/hour per-IP limit and 429s with {error:"rate_limited"}', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-12T20:00:00Z') });
      vi.stubGlobal('fetch', mockFetchOk());

      let last;
      for (let i = 0; i < 20; i++) {
        last = await testLabPOST(post({ action: 'send', kind: 'thankyou_v1' }));
      }
      expect(last!.status).toBe(200); // 20th request still under budget

      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);
      const blocked = await testLabPOST(post({ action: 'send', kind: 'thankyou_v1' }));
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({ error: 'rate_limited' });
      expect(fetchMock).not.toHaveBeenCalled(); // blocked before any send attempt
    });

    it('preview is NOT rate-limited by the same budget — only send counts', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-12T20:00:00Z') });
      for (let i = 0; i < 20; i++) {
        await testLabPOST(post({ action: 'preview', kind: 'thankyou_v1' }));
      }
      const res = await testLabPOST(post({ action: 'preview', kind: 'thankyou_v1' }));
      expect(res.status).toBe(200); // previews never touch the send-only limiter
    });
  });
});
