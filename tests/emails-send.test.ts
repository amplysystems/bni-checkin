import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendEmailMessage, isSafeModeOn, type SendableMessage } from '@/lib/emails/send';

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

  it('EMAIL_SAFE_MODE unset defaults to ON (fails safe, never open)', () => {
    vi.stubEnv('EMAIL_SAFE_MODE', undefined);
    expect(isSafeModeOn()).toBe(true);
  });

  it('EMAIL_SAFE_MODE="0" with a verified EMAIL_FROM turns safe mode OFF', () => {
    expect(isSafeModeOn()).toBe(false);
  });

  it('any non-"0" value counts as ON (fails safe on typos)', () => {
    vi.stubEnv('EMAIL_SAFE_MODE', 'off');
    expect(isSafeModeOn()).toBe(true);
  });

  it('forces safe mode ON when EMAIL_FROM is the resend.dev fallback, even with EMAIL_SAFE_MODE=0', () => {
    vi.stubEnv('EMAIL_FROM', 'onboarding@resend.dev');
    expect(isSafeModeOn()).toBe(true);
  });

  it('forces safe mode ON when EMAIL_FROM is unset (implicit fallback)', () => {
    vi.stubEnv('EMAIL_FROM', undefined);
    expect(isSafeModeOn()).toBe(true);
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
