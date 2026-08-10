import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emailMessages } from '@/db/schema';
import { setDb } from '@/lib/db';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { runWeeklyExport } from '@/lib/emails/export';
import { POST as exportPOST } from '@/app/api/cron/weekly-export/route';

const SUNDAY = new Date('2026-08-16T08:00:00Z'); // 03:00 CT Sunday — the cron's own schedule instant

function mockFetchOk(id = 'resend-export-1') {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id }), text: async () => '' });
}

describe('lib/emails/export: runWeeklyExport', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends via the send.ts choke point, addressed to the owner, with a JSON attachment', async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runWeeklyExport(db, SUNDAY);
    expect(result.providerMessageId).toBe('resend-export-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(['barriosj4@gmail.com']);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toMatch(/^bni-checkin-export-\d{4}-\d{2}-\d{2}\.json$/);

    const decoded = JSON.parse(Buffer.from(body.attachments[0].content, 'base64').toString('utf-8'));
    expect(decoded).toHaveProperty('generatedAt');
    for (const table of ['people', 'meetings', 'attendance', 'memberships', 'personRoles', 'emailMessages', 'settings']) {
      expect(decoded.tables).toHaveProperty(table);
      expect(Array.isArray(decoded.tables[table])).toBe(true);
    }
    expect(decoded.tables.people.length).toBeGreaterThan(0); // seed data present
  });

  it('excludes bodySnapshot from the email_messages dump (payload shape)', async () => {
    await db.insert(emailMessages).values({
      sendKey: 'export-test:leadership_report', type: 'leadership_report', meetingId: null,
      recipients: ['x@example.com'], subject: 'x', bodySnapshot: '<p>SENSITIVE-MARKER</p>', state: 'draft',
    });

    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);
    await runWeeklyExport(db, SUNDAY);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const decoded = Buffer.from(body.attachments[0].content, 'base64').toString('utf-8');
    expect(decoded).not.toContain('SENSITIVE-MARKER');
    expect(decoded).not.toContain('bodySnapshot');
    const parsed = JSON.parse(decoded);
    const dumped = parsed.tables.emailMessages.find((m: { sendKey: string }) => m.sendKey === 'export-test:leadership_report');
    expect(dumped).toBeTruthy();
    expect(dumped).not.toHaveProperty('bodySnapshot');
    expect(dumped.subject).toBe('x'); // other fields still present
  });

  it('SAFE_MODE still applies (recipient is already the owner, but the choke point discipline still runs)', async () => {
    vi.stubEnv('EMAIL_SAFE_MODE', undefined); // default ON
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    await runWeeklyExport(db, SUNDAY);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(['barriosj4@gmail.com']); // no functional change — owner was already the recipient
    expect(body.subject).toContain('[SAFE→barriosj4@gmail.com]');
  });

  it('returns per-table row counts matching the attached dump', async () => {
    vi.stubGlobal('fetch', mockFetchOk());
    const result = await runWeeklyExport(db, SUNDAY);
    expect(result.tableCounts.people).toBeGreaterThan(0);
    expect(typeof result.tableCounts.meetings).toBe('number');
    expect(typeof result.tableCounts.settings).toBe('number');
  });
});

describe('POST /api/cron/weekly-export', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    setDb(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function req(headers: Record<string, string> = {}) {
    return new Request('http://cron.test/api/cron/weekly-export', { method: 'POST', headers });
  }

  it('501s when CRON_SECRET is unset', async () => {
    vi.stubEnv('CRON_SECRET', undefined);
    const res = await exportPOST(req());
    expect(res.status).toBe(501);
  });

  it('401s on a missing or wrong secret', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret');
    expect((await exportPOST(req())).status).toBe(401);
    expect((await exportPOST(req({ 'x-cron-secret': 'wrong' }))).status).toBe(401);
  });

  it('200s, sends the export, and returns table counts when the secret matches', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubGlobal('fetch', mockFetchOk());

    const res = await exportPOST(req({ 'x-cron-secret': 'right-secret' }));
    expect(res.status).toBe(200);
    const jsonBody = await res.json();
    expect(jsonBody.tableCounts).toBeTruthy();
    expect(jsonBody.providerMessageId).toBe('resend-export-1');
  });
});
