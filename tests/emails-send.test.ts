import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { sendEmailMessage, sendTestEmail, isSafeModeActive, type SendableMessage } from '@/lib/emails/send';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { settings } from '@/db/schema';

const OWNER = 'barriosj4@gmail.com';

function mockFetchOk(id = 'resend-msg-1') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id }),
    text: async () => '',
  });
}

function baseMessage(overrides: Partial<SendableMessage> = {}): SendableMessage {
  return {
    type: 'visitor_thankyou',
    sendKey: 'meeting-1:visitor_thankyou:person-1',
    recipients: ['visitor@example.com'],
    subject: 'Great meeting you today, Dana',
    html: '<p>hi</p>',
    text: 'hi',
    ...overrides,
  };
}

describe('lib/emails/send', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('EMAIL_SAFE_MODE unset defaults to ON (fails safe, never open)', async () => {
    vi.stubEnv('EMAIL_SAFE_MODE', undefined);
    expect(await isSafeModeActive()).toBe(true);
  });

  it('EMAIL_SAFE_MODE="0" with a verified EMAIL_FROM turns safe mode OFF', async () => {
    expect(await isSafeModeActive()).toBe(false);
  });

  it('any non-"0" value counts as ON (fails safe on typos)', async () => {
    vi.stubEnv('EMAIL_SAFE_MODE', 'off');
    expect(await isSafeModeActive()).toBe(true);
  });

  it('forces safe mode ON when EMAIL_FROM is the resend.dev fallback, even with EMAIL_SAFE_MODE=0', async () => {
    vi.stubEnv('EMAIL_FROM', 'onboarding@resend.dev');
    expect(await isSafeModeActive()).toBe(true);
  });

  it('forces safe mode ON when EMAIL_FROM is unset (implicit fallback)', async () => {
    vi.stubEnv('EMAIL_FROM', undefined);
    expect(await isSafeModeActive()).toBe(true);
  });

  it('safe mode OFF: sends to the real recipient with the unmodified subject', async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    await sendEmailMessage(baseMessage({ recipients: ['visitor@example.com'] }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(['visitor@example.com']);
    expect(body.subject).toBe('Great meeting you today, Dana');
  });

  it('safe mode ON: redirects recipient to the owner and prefixes the subject with [SAFE→original]', async () => {
    vi.stubEnv('EMAIL_SAFE_MODE', '1');
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    await sendEmailMessage(baseMessage({ recipients: ['visitor@example.com'] }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual([OWNER]);
    expect(body.subject).toBe('[SAFE→visitor@example.com] Great meeting you today, Dana');
  });

  it('safe mode ON with multiple recipients (leadership report) joins them in the prefix', async () => {
    vi.stubEnv('EMAIL_SAFE_MODE', '1');
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    await sendEmailMessage(baseMessage({
      type: 'leadership_report',
      recipients: ['carey@example.com', 'marisa@example.com'],
      subject: 'Weekly report',
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual([OWNER]);
    expect(body.subject).toBe('[SAFE→carey@example.com, marisa@example.com] Weekly report');
  });

  it('attaches an ICS invite (base64) for visitor_thankyou but not for leadership_report', async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    await sendEmailMessage(baseMessage({ type: 'visitor_thankyou' }));
    let body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe('bni-wheeling-meeting.ics');
    const decoded = Buffer.from(body.attachments[0].content, 'base64').toString('utf-8');
    expect(decoded).toContain('BEGIN:VCALENDAR');

    fetchMock.mockClear();
    await sendEmailMessage(baseMessage({ type: 'leadership_report' }));
    body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.attachments).toBeUndefined();
  });

  it('sends the send_key as the Idempotency-Key header, stable regardless of SAFE_MODE', async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);
    await sendEmailMessage(baseMessage({ sendKey: 'meeting-42:visitor_thankyou:person-7' }));
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('meeting-42:visitor_thankyou:person-7');

    fetchMock.mockClear();
    vi.stubEnv('EMAIL_SAFE_MODE', '1'); // recipient/subject get rewritten; the key must not change
    await sendEmailMessage(baseMessage({ sendKey: 'meeting-42:visitor_thankyou:person-7' }));
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('meeting-42:visitor_thankyou:person-7');
  });

  it('sets Reply-To to the owner address', async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);
    await sendEmailMessage(baseMessage());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.replyTo).toBe(OWNER);
  });

  it('returns the Resend providerMessageId on success', async () => {
    vi.stubGlobal('fetch', mockFetchOk('msg-abc-123'));
    const result = await sendEmailMessage(baseMessage());
    expect(result.providerMessageId).toBe('msg-abc-123');
  });

  it('throws SendError on a non-ok Resend response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 422, text: async () => 'invalid payload',
    }));
    await expect(sendEmailMessage(baseMessage())).rejects.toThrow(/Resend send failed: 422/);
  });

  it('throws SendError if the response is ok but has no message id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(sendEmailMessage(baseMessage())).rejects.toThrow(/missing message id/);
  });
});

// Migration 0008: settings.email_safe_mode overrides isSafeModeActive's
// env-based default when a `db` handle is threaded through — see
// lib/emails/send.ts's own comment on the precedence order.
describe('isSafeModeActive settings override (migration 0008)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('EMAIL_SAFE_MODE', '0'); // env says OFF unless overridden
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('NULL (never configured) falls back to the env default', async () => {
    // seed's settings row has emailSafeMode unset -> NULL.
    expect(await isSafeModeActive(db)).toBe(false); // env says OFF, verified sender

    vi.stubEnv('EMAIL_SAFE_MODE', undefined); // env default flips to ON
    expect(await isSafeModeActive(db)).toBe(true);
  });

  it('an explicit true override wins over an env default of OFF', async () => {
    await db.update(settings).set({ emailSafeMode: true }).where(eq(settings.id, 1));
    expect(await isSafeModeActive(db)).toBe(true);
  });

  it('an explicit false override wins over an env default of ON', async () => {
    vi.stubEnv('EMAIL_SAFE_MODE', undefined); // env default would otherwise be ON
    await db.update(settings).set({ emailSafeMode: false }).where(eq(settings.id, 1));
    expect(await isSafeModeActive(db)).toBe(false);
  });

  it('the forced-ON-on-fallback-sender guard beats an explicit false override', async () => {
    vi.stubEnv('EMAIL_FROM', 'onboarding@resend.dev'); // unverified sender
    await db.update(settings).set({ emailSafeMode: false }).where(eq(settings.id, 1));
    expect(await isSafeModeActive(db)).toBe(true);
  });

  it('sendEmailMessage threaded with db respects the settings override end-to-end', async () => {
    await db.update(settings).set({ emailSafeMode: true }).where(eq(settings.id, 1));
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    await sendEmailMessage(baseMessage({ recipients: ['visitor@example.com'] }), undefined, db);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual([OWNER]); // redirected — override forced it ON despite env='0'
    vi.unstubAllGlobals();
  });

  it('sendEmailMessage called with NO db falls back to the env-only overload, ignoring any override in the db', async () => {
    // If a db handle isn't threaded through at all, the settings table is
    // never even queried — env alone decides, exactly like before
    // migration 0008 existed.
    await db.update(settings).set({ emailSafeMode: true }).where(eq(settings.id, 1));
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);

    await sendEmailMessage(baseMessage({ recipients: ['visitor@example.com'] }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(['visitor@example.com']); // NOT redirected — env says OFF, no db consulted
    vi.unstubAllGlobals();
  });
});

describe('sendTestEmail (admin Test Lab send path)', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends to exactly the given recipient with a [TEST] subject prefix, bypassing safe mode entirely', async () => {
    vi.stubEnv('EMAIL_SAFE_MODE', '1'); // even with safe mode ON —
    const fetchMock = mockFetchOk('test-msg-1');
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendTestEmail({
      to: 'admin@example.com', subject: 'Great meeting you today, Dana', html: '<p>hi</p>', text: 'hi',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(['admin@example.com']); // never redirected/collapsed by safe mode
    expect(body.subject).toBe('[TEST] Great meeting you today, Dana');
    expect(result.providerMessageId).toBe('test-msg-1');
  });

  it('sets an Idempotency-Key header (still respects the fetch/Idempotency pattern)', async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal('fetch', fetchMock);
    await sendTestEmail({ to: 'admin@example.com', subject: 'x', html: '<p>x</p>' });
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toMatch(/^test-email:/);
  });

  it('throws SendError on a non-ok Resend response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(sendTestEmail({ to: 'admin@example.com', subject: 'x', html: '<p>x</p>' }))
      .rejects.toThrow(/Resend send failed: 500/);
  });
});
