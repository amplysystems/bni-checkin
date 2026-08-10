import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/auth';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { setDb } from '@/lib/db';
import { emailMessages, settings } from '@/db/schema';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { registerVisitor } from '@/lib/visitors';
import { createDrafts } from '@/lib/emails/engine';
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
});
