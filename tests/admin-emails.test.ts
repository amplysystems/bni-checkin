import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/auth';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { setDb } from '@/lib/db';
import { emailMessages, meetings, settings } from '@/db/schema';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { registerVisitor } from '@/lib/visitors';
import { createDrafts, ensureRsvpNotice } from '@/lib/emails/engine';
import { runWeeklyExport } from '@/lib/emails/export';
import { visitorThankyouSubject } from '@/emails/visitor-thankyou';
import { GET as emailsGET, POST as emailsPOST } from '@/app/api/admin/emails/route';
import { GET as settingsGET, POST as settingsPOST } from '@/app/api/admin/settings/route';

const mockAuth = vi.mocked(auth);
const asEmail = (email: string) => mockAuth.mockResolvedValue(
  { user: { email } } as unknown as Awaited<ReturnType<typeof auth>>,
);
const asAdmin = () => asEmail('barriosj4@gmail.com');

function post(url: string, body: unknown) {
  return new Request(`http://admin.test${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

// Wednesday 2026-08-12, 14:00 CT — same fixture convention as tests/emails.test.ts.
const NOW = new Date('2026-08-12T19:00:00Z');

function mockFetchOk(id = 'resend-1') {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id }), text: async () => '' });
}
function mockFetchFail(status = 500, body = 'boom') {
  return vi.fn().mockResolvedValue({ ok: false, status, text: async () => body });
}

type EmailMessageOut = {
  id: string; type: string; label: string; state: string;
  meetingId: string | null; meetingDate: string | null; error: string | null;
};

describe('admin emails API (app/api/admin/emails)', () => {
  let db: TestDb;
  let meetingId: string;
  let meetingDate: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    setDb(db);
    vi.stubEnv('ADMIN_ALLOWLIST', 'barriosj4@gmail.com');
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');
    asAdmin();

    await registerVisitor(db, {
      fullName: 'Dana Whitfield', industry: 'Roofing', company: null,
      email: 'dana@example.com', phone: null, clientOpId: 'v-1', now: NOW,
    });
    const meeting = await getOrCreateMeetingFor(db, NOW);
    meetingId = meeting.id;
    meetingDate = meeting.meetingDate;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('GET', () => {
    it('lists compiled drafts grouped by meeting, with a plain-English visitor label', async () => {
      await createDrafts(db, meetingId);
      const res = await emailsGET();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: EmailMessageOut[] };

      const thankyou = body.messages.find((m) => m.type === 'visitor_thankyou')!;
      expect(thankyou.label).toBe('Visitor thank-you · Dana Whitfield');
      expect(thankyou.meetingId).toBe(meetingId);
      expect(thankyou.meetingDate).toBe(meetingDate);
      expect(thankyou.state).toBe('awaiting_approval'); // approveMode default ON

      const report = body.messages.find((m) => m.type === 'leadership_report')!;
      expect(report.label).toBe('Weekly report');
    });

    it('surfaces the latest weekly_export row once runWeeklyExport records one', async () => {
      vi.stubGlobal('fetch', mockFetchOk('export-1'));
      await runWeeklyExport(db, NOW);

      const body = (await (await emailsGET()).json()) as { messages: EmailMessageOut[] };
      const exportRow = body.messages.find((m) => m.type === 'weekly_export')!;
      expect(exportRow).toBeTruthy();
      expect(exportRow.label).toBe('Weekly export');
      expect(exportRow.state).toBe('sent');
      expect(exportRow.meetingId).toBeNull();
    });

    it('includes rsvp_notice rows (P2-6 carry-in — previously invisible, breaking failed-rows recovery)', async () => {
      const [notice] = await db.insert(emailMessages).values({
        sendKey: 'rsvp_notice:some-token', type: 'rsvp_notice', meetingId: null,
        recipients: ['barriosj4@gmail.com'], subject: 'Dana Whitfield plans to visit Wednesday',
        state: 'failed', error: 'Failed after 3 attempts: boom',
      }).returning();

      const body = (await (await emailsGET()).json()) as { messages: EmailMessageOut[] };
      const found = body.messages.find((m) => m.id === notice.id);
      expect(found).toBeTruthy();
      expect(found!.label).toBe('RSVP notice');
      expect(found!.state).toBe('failed');
      expect(found!.meetingId).toBeNull();

      // Retry (Send now on a failed row) works exactly like any other
      // failed row — the whole point of surfacing it here at all.
      const fetchMock = mockFetchOk('rsvp-recovered-1');
      vi.stubGlobal('fetch', fetchMock);
      const retryRes = await emailsPOST(post('/api/admin/emails', { action: 'sendNow', id: notice.id }));
      expect(retryRes.status).toBe(200);
      expect((await retryRes.json()).message.state).toBe('sent');
    });

    it('reflects SAFE_MODE from the environment (review carry-in)', async () => {
      vi.stubEnv('EMAIL_SAFE_MODE', undefined); // default ON
      const onBody = (await (await emailsGET()).json()) as { safeMode: boolean };
      expect(onBody.safeMode).toBe(true);

      vi.stubEnv('EMAIL_SAFE_MODE', '0'); // EMAIL_FROM already stubbed to a real sender in beforeEach
      const offBody = (await (await emailsGET()).json()) as { safeMode: boolean };
      expect(offBody.safeMode).toBe(false);
    });

    // Migration 0008: the amber "test mode is on" banner in the admin UI
    // reads this same `safeMode` field — confirming it now reflects the
    // settings-column override (not just the env default) is what makes
    // the banner trustworthy once an admin has used the toggle.
    it('reflects the settings.email_safe_mode override over the env default', async () => {
      vi.stubEnv('EMAIL_SAFE_MODE', '0'); // env alone would say OFF
      await settingsPOST(post('/api/admin/settings', { emailSafeMode: true }));
      const onBody = (await (await emailsGET()).json()) as { safeMode: boolean };
      expect(onBody.safeMode).toBe(true);

      vi.stubEnv('EMAIL_SAFE_MODE', undefined); // env alone would say ON
      await settingsPOST(post('/api/admin/settings', { emailSafeMode: false }));
      const offBody = (await (await emailsGET()).json()) as { safeMode: boolean };
      expect(offBody.safeMode).toBe(false);
    });
  });

  describe('POST action=preview', () => {
    it('returns the stored HTML/subject without sending anything (no Resend call)', async () => {
      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;

      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      const res = await emailsPOST(post('/api/admin/emails', { action: 'preview', id: thankyou.id }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.subject).toBe(visitorThankyouSubject('Dana'));
      expect(body.html).toContain('BNI Wheeling');
      expect(fetchMock).not.toHaveBeenCalled(); // never sent

      const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, thankyou.id));
      expect(row.state).toBe('awaiting_approval'); // untouched by preview
    });

    it('recompiles live when bodySnapshot is missing', async () => {
      const [orphan] = await db.insert(emailMessages).values({
        sendKey: `${meetingId}:leadership_report`, type: 'leadership_report', meetingId,
        recipients: ['x@example.com'], subject: 'x', state: 'draft', bodySnapshot: null,
      }).returning();

      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      const res = await emailsPOST(post('/api/admin/emails', { action: 'preview', id: orphan.id }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.html).toContain('Weekly report');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('400s for an unknown id', async () => {
      const res = await emailsPOST(post('/api/admin/emails', {
        action: 'preview', id: '00000000-0000-0000-0000-000000000000',
      }));
      expect(res.status).toBe(400);
    });
  });

  describe('POST action=approve', () => {
    it('moves an awaiting_approval message to scheduled and stamps who approved it', async () => {
      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;
      expect(thankyou.state).toBe('awaiting_approval');

      const res = await emailsPOST(post('/api/admin/emails', { action: 'approve', id: thankyou.id }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message.state).toBe('scheduled');
      expect(body.message.approvedBy).toBe('admin:barriosj4@gmail.com');
    });

    it('400s not_awaiting_approval for a message already past that state', async () => {
      await db.update(settings).set({ approveMode: false }).where(eq(settings.id, 1));
      const { created } = await createDrafts(db, meetingId); // lands straight in 'scheduled'
      const res = await emailsPOST(post('/api/admin/emails', { action: 'approve', id: created[0].id }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('not_awaiting_approval');
    });

    it('400s for an unknown id', async () => {
      const res = await emailsPOST(post('/api/admin/emails', {
        action: 'approve', id: '00000000-0000-0000-0000-000000000000',
      }));
      expect(res.status).toBe(400);
    });
  });

  describe('POST action=sendNow (also the failed-row Retry path)', () => {
    it('sends immediately regardless of approval state', async () => {
      const fetchMock = mockFetchOk('sendnow-1');
      vi.stubGlobal('fetch', fetchMock);
      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;

      const res = await emailsPOST(post('/api/admin/emails', { action: 'sendNow', id: thankyou.id }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message.state).toBe('sent');
      expect(body.message.providerMessageId).toBe('sendnow-1');
    });

    it('retries a failed row back to sent — the only recovery path a failed row has', async () => {
      vi.stubGlobal('fetch', mockFetchFail(500, 'down'));
      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;

      const failedRes = await emailsPOST(post('/api/admin/emails', { action: 'sendNow', id: thankyou.id }));
      expect((await failedRes.json()).message.state).toBe('failed');

      // The GET listing is the failed-rows list the P2-4 carry-in requires —
      // confirm the failure (with its reason) actually surfaces there.
      const listed = (await (await emailsGET()).json()) as { messages: EmailMessageOut[] };
      const failedRow = listed.messages.find((m) => m.id === thankyou.id)!;
      expect(failedRow.state).toBe('failed');
      expect(failedRow.error).toContain('Failed after 3 attempts');

      vi.stubGlobal('fetch', mockFetchOk('recovered-1'));
      const retryRes = await emailsPOST(post('/api/admin/emails', { action: 'sendNow', id: thankyou.id }));
      expect(retryRes.status).toBe(200);
      const retryBody = await retryRes.json();
      expect(retryBody.message.state).toBe('sent');
      expect(retryBody.message.providerMessageId).toBe('recovered-1');
    });
  });

  describe('POST action=compile (arbitrary-date / special-meeting path)', () => {
    it('404s when no meeting exists on that date', async () => {
      const res = await emailsPOST(post('/api/admin/emails', { action: 'compile', meetingDate: '2099-01-07' }));
      expect(res.status).toBe(404);
    });

    // CRITICAL review carry-in: createDrafts is create-only (ON CONFLICT DO
    // NOTHING on send_key), so a premature compile against a
    // zero-attendance meeting would permanently claim that meeting's
    // send_key rows — the real evening compile, once people actually check
    // in, would then silently skip everything. Same two gates as
    // lib/emails/tick.ts's cron sweep, enforced here with no override.
    it('400s and creates NO drafts for a meeting with zero attendance', async () => {
      const [emptyMeeting] = await db.insert(meetings).values({
        meetingDate: '2026-08-19', startsAt: new Date('2026-08-19T20:30:00Z'),
      }).returning();

      const res = await emailsPOST(post('/api/admin/emails', { action: 'compile', meetingDate: '2026-08-19' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('That meeting has no check-ins yet — emails get ready on their own once people check in.');

      const rows = await db.select().from(emailMessages).where(eq(emailMessages.meetingId, emptyMeeting.id));
      expect(rows).toHaveLength(0); // send_key never claimed — the real compile later isn't blocked
    });

    it('400s for a canceled meeting', async () => {
      const [canceled] = await db.insert(meetings).values({
        meetingDate: '2026-08-26', startsAt: new Date('2026-08-26T20:30:00Z'), status: 'canceled',
      }).returning();

      const res = await emailsPOST(post('/api/admin/emails', { action: 'compile', meetingDate: '2026-08-26' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('That meeting was canceled.');

      const rows = await db.select().from(emailMessages).where(eq(emailMessages.meetingId, canceled.id));
      expect(rows).toHaveLength(0);
    });

    it('compiles drafts for a real meeting date with attendance', async () => {
      const res = await emailsPOST(post('/api/admin/emails', { action: 'compile', meetingDate }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.meetingId).toBe(meetingId);
      expect(body.created).toBe(2); // leadership_report + Dana's thank-you

      const rows = await db.select().from(emailMessages).where(eq(emailMessages.meetingId, meetingId));
      expect(rows).toHaveLength(2);
    });

    it('is idempotent: calling it twice does not duplicate rows', async () => {
      await emailsPOST(post('/api/admin/emails', { action: 'compile', meetingDate }));
      const res = await emailsPOST(post('/api/admin/emails', { action: 'compile', meetingDate }));
      const body = await res.json();
      expect(body.created).toBe(0);
      expect(body.skipped).toBe(2);
    });

    it('rejects a malformed date with 400', async () => {
      const res = await emailsPOST(post('/api/admin/emails', { action: 'compile', meetingDate: 'not-a-date' }));
      expect(res.status).toBe(400);
    });
  });
});

describe('admin settings API (app/api/admin/settings)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    setDb(db);
    vi.stubEnv('ADMIN_ALLOWLIST', 'barriosj4@gmail.com');
    asAdmin();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('GET returns the seeded defaults', async () => {
    const res = await settingsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.approveMode).toBe(true);
    expect(body.settings.reportSendTime).toBe('17:30');
    expect(body.settings.thankyouSendTime).toBe('17:00');
  });

  it('approveMode can be toggled on its own', async () => {
    const res = await settingsPOST(post('/api/admin/settings', { approveMode: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).settings.approveMode).toBe(false);

    const after = await (await settingsGET()).json();
    expect(after.settings.approveMode).toBe(false);
  });

  describe('send-time hard clamp to [16:45, 19:45] CT', () => {
    it('16:44 is rejected with a plain-English error naming the window', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { thankyouSendTime: '16:44' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/4:45 PM/);
      expect(body.error).toMatch(/7:45 PM/);
    });

    it('16:45 is accepted (inclusive lower bound)', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { thankyouSendTime: '16:45' }));
      expect(res.status).toBe(200);
      expect((await res.json()).settings.thankyouSendTime).toBe('16:45');
    });

    it('19:45 is accepted (inclusive upper bound)', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { reportSendTime: '19:45' }));
      expect(res.status).toBe(200);
      expect((await res.json()).settings.reportSendTime).toBe('19:45');
    });

    it('19:46 is rejected', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { reportSendTime: '19:46' }));
      expect(res.status).toBe(400);
    });

    it('junk input is rejected', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { reportSendTime: 'not-a-time' }));
      expect(res.status).toBe(400);
    });
  });

  describe('reportRecipients validation', () => {
    it('accepts a list of valid emails', async () => {
      const res = await settingsPOST(post('/api/admin/settings', {
        reportRecipients: ['carey@example.com', 'marisa@example.com'],
      }));
      expect(res.status).toBe(200);
      expect((await res.json()).settings.reportRecipients).toEqual(['carey@example.com', 'marisa@example.com']);
    });

    it('an empty list clears recipients (Jason still always gets the report via the engine, not this list)', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { reportRecipients: [] }));
      expect(res.status).toBe(200);
      expect((await res.json()).settings.reportRecipients).toEqual([]);
    });

    it('rejects an invalid email in the list', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { reportRecipients: ['not-an-email'] }));
      expect(res.status).toBe(400);
    });

    it('rejects more than 10 recipients', async () => {
      const many = Array.from({ length: 11 }, (_, i) => `person${i}@example.com`);
      const res = await settingsPOST(post('/api/admin/settings', { reportRecipients: many }));
      expect(res.status).toBe(400);
    });

    it('rejects an email over 320 characters', async () => {
      const longLocal = 'a'.repeat(310);
      const res = await settingsPOST(post('/api/admin/settings', {
        reportRecipients: [`${longLocal}@example.com`],
      }));
      expect(res.status).toBe(400);
    });
  });

  it('an empty body is rejected as "no changes to save"', async () => {
    const res = await settingsPOST(post('/api/admin/settings', {}));
    expect(res.status).toBe(400);
  });

  // Migration 0008 (System test / safe-mode toggle): settings.email_safe_mode.
  describe('emailSafeMode (migration 0008)', () => {
    it('defaults to null (never configured — follows the env default)', async () => {
      const res = await settingsGET();
      const body = await res.json();
      expect(body.settings.emailSafeMode).toBeNull();
    });

    it('persists an explicit true, then false, across GETs', async () => {
      const onRes = await settingsPOST(post('/api/admin/settings', { emailSafeMode: true }));
      expect(onRes.status).toBe(200);
      expect((await onRes.json()).settings.emailSafeMode).toBe(true);
      expect((await (await settingsGET()).json()).settings.emailSafeMode).toBe(true);

      const offRes = await settingsPOST(post('/api/admin/settings', { emailSafeMode: false }));
      expect(offRes.status).toBe(200);
      expect((await offRes.json()).settings.emailSafeMode).toBe(false);
      expect((await (await settingsGET()).json()).settings.emailSafeMode).toBe(false);
    });

    it('accepts null explicitly (back to "follow the env default")', async () => {
      await settingsPOST(post('/api/admin/settings', { emailSafeMode: true }));
      const res = await settingsPOST(post('/api/admin/settings', { emailSafeMode: null }));
      expect(res.status).toBe(200);
      expect((await res.json()).settings.emailSafeMode).toBeNull();
    });
  });

  // P2-6 carry-in: rsvpNotifyCarey / careyEmail (settings columns added by
  // migration 0007) — the toggle can only ever end up ON with an address
  // actually on file.
  describe('rsvpNotifyCarey / careyEmail (P2-6 carry-in)', () => {
    it('defaults to off, with no address on file', async () => {
      const res = await settingsGET();
      const body = await res.json();
      expect(body.settings.rsvpNotifyCarey).toBe(false);
      expect(body.settings.careyEmail).toBeNull();
    });

    it('turning the toggle on with no careyEmail already stored is rejected', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { rsvpNotifyCarey: true }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Add Carey's email before turning this on.");
    });

    it('setting careyEmail alone (toggle still off) is accepted', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { careyEmail: 'carey@example.com' }));
      expect(res.status).toBe(200);
      expect((await res.json()).settings.careyEmail).toBe('carey@example.com');
    });

    it('turning the toggle on once an address is already stored is accepted', async () => {
      await settingsPOST(post('/api/admin/settings', { careyEmail: 'carey@example.com' }));
      const res = await settingsPOST(post('/api/admin/settings', { rsvpNotifyCarey: true }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.settings.rsvpNotifyCarey).toBe(true);
      expect(body.settings.careyEmail).toBe('carey@example.com');
    });

    it('setting BOTH fields together in one request is accepted', async () => {
      const res = await settingsPOST(post('/api/admin/settings', {
        rsvpNotifyCarey: true, careyEmail: 'carey@example.com',
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.settings.rsvpNotifyCarey).toBe(true);
      expect(body.settings.careyEmail).toBe('carey@example.com');
    });

    it('clearing careyEmail back to null while the toggle is already on is rejected (would silently notify nobody)', async () => {
      await settingsPOST(post('/api/admin/settings', { rsvpNotifyCarey: true, careyEmail: 'carey@example.com' }));
      const res = await settingsPOST(post('/api/admin/settings', { careyEmail: null }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Add Carey's email before turning this on.");

      // Nothing changed — still on with the old address, not silently
      // half-cleared.
      const after = await (await settingsGET()).json();
      expect(after.settings.careyEmail).toBe('carey@example.com');
      expect(after.settings.rsvpNotifyCarey).toBe(true);
    });

    it('turning the toggle off while clearing careyEmail in the SAME request is accepted', async () => {
      await settingsPOST(post('/api/admin/settings', { rsvpNotifyCarey: true, careyEmail: 'carey@example.com' }));
      const res = await settingsPOST(post('/api/admin/settings', { rsvpNotifyCarey: false, careyEmail: null }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.settings.rsvpNotifyCarey).toBe(false);
      expect(body.settings.careyEmail).toBeNull();
    });

    it('rejects a malformed careyEmail', async () => {
      const res = await settingsPOST(post('/api/admin/settings', { careyEmail: 'not-an-email' }));
      expect(res.status).toBe(400);
    });
  });
});

// P2-6 carry-in: ensureRsvpNotice adds Carey as a second recipient only
// when BOTH rsvpNotifyCarey is true AND careyEmail is set.
describe('lib/emails/engine ensureRsvpNotice — Carey recipient (P2-6 carry-in)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    setDb(db);
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('recipients stay owner-only when the toggle is off, even with an address on file', async () => {
    vi.stubGlobal('fetch', mockFetchOk('carey-1'));
    await db.update(settings).set({ rsvpNotifyCarey: false, careyEmail: 'carey@example.com' }).where(eq(settings.id, 1));

    const result = await ensureRsvpNotice(db, { token: 'tok-1', purpose: 'rsvp', personFullName: 'Val Visitor' });
    expect(result?.recipients).toEqual(['barriosj4@gmail.com']);
  });

  it('recipients stay owner-only when the toggle is on but no address is on file', async () => {
    vi.stubGlobal('fetch', mockFetchOk('carey-2'));
    await db.update(settings).set({ rsvpNotifyCarey: true, careyEmail: null }).where(eq(settings.id, 1));

    const result = await ensureRsvpNotice(db, { token: 'tok-2', purpose: 'rsvp', personFullName: 'Val Visitor' });
    expect(result?.recipients).toEqual(['barriosj4@gmail.com']);
  });

  it('Carey is added as a second recipient when BOTH the toggle is on AND an address is on file', async () => {
    vi.stubGlobal('fetch', mockFetchOk('carey-3'));
    await db.update(settings).set({ rsvpNotifyCarey: true, careyEmail: 'carey@example.com' }).where(eq(settings.id, 1));

    const result = await ensureRsvpNotice(db, { token: 'tok-3', purpose: 'rsvp', personFullName: 'Val Visitor' });
    expect(result?.recipients).toEqual(['barriosj4@gmail.com', 'carey@example.com']);
  });

  it('SAFE_MODE still redirects everything to the owner even with Carey enabled', async () => {
    vi.stubEnv('EMAIL_SAFE_MODE', '1');
    const fetchMock = mockFetchOk('carey-4');
    vi.stubGlobal('fetch', fetchMock);
    await db.update(settings).set({ rsvpNotifyCarey: true, careyEmail: 'carey@example.com' }).where(eq(settings.id, 1));

    await ensureRsvpNotice(db, { token: 'tok-4', purpose: 'rsvp', personFullName: 'Val Visitor' });

    // The STORED row still lists Carey as an intended recipient (recipients
    // reflects who was addressed, not who actually received it under SAFE
    // MODE) — the actual Resend payload sent is what's redirected, which
    // is send.ts's job (already covered by tests/emails-send.test.ts), not
    // this row.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(callBody.to).toEqual(['barriosj4@gmail.com']); // redirected — Carey never actually sent to
  });
});
