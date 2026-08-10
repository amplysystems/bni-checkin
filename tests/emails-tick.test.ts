import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { emailMessages, meetings, settings } from '@/db/schema';
import { setDb } from '@/lib/db';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { registerVisitor } from '@/lib/visitors';
import { reapStaleSending } from '@/lib/emails/engine';
import { runEmailTick } from '@/lib/emails/tick';
import { POST as tickPOST } from '@/app/api/cron/email-tick/route';

// Wednesday 2026-08-12. August sits in CDT (America/Chicago is UTC-5), same
// fixture convention as tests/emails.test.ts and tests/emails-ics.test.ts.
const NOW = new Date('2026-08-12T19:00:00Z'); // 14:00 CT — meeting check-in time
const BEFORE_GATE = new Date('2026-08-12T21:30:00Z'); // 16:30 CT — before the 16:45 compile gate
const AT_GATE = new Date('2026-08-12T21:45:00Z'); // 16:45 CT exactly — inclusive boundary
const AFTER_GATE_BEFORE_SEND = new Date('2026-08-12T22:00:00Z'); // 17:00 CT — gate passed, nothing due yet
const AFTER_ALL_SEND = new Date('2026-08-12T23:00:00Z'); // 18:00 CT — both default send times passed

function mockFetchOk(id = 'resend-1') {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id }), text: async () => '' });
}

describe('lib/emails/tick: runEmailTick', () => {
  let db: TestDb;
  let meetingId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    setDb(db);
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');

    await registerVisitor(db, {
      fullName: 'Dana Visitor', industry: 'Roofing', company: null,
      email: 'dana@example.com', phone: null, clientOpId: 'v-1', now: NOW,
    });
    const meeting = await getOrCreateMeetingFor(db, NOW);
    meetingId = meeting.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function messagesFor(type?: 'leadership_report' | 'visitor_thankyou' | 'approval_notice') {
    const rows = await db.select().from(emailMessages).where(eq(emailMessages.meetingId, meetingId));
    return type ? rows.filter((r) => r.type === type) : rows;
  }

  describe('the 16:45 CT draft-compile gate', () => {
    it('before 16:45 CT: does not compile drafts', async () => {
      vi.stubGlobal('fetch', mockFetchOk());
      const result = await runEmailTick(db, BEFORE_GATE);
      expect(result.meetingId).toBeNull();
      expect(result.draftsCreated).toBe(0);
      expect(await messagesFor()).toHaveLength(0);
    });

    it('at exactly 16:45 CT: compiles drafts (inclusive boundary)', async () => {
      vi.stubGlobal('fetch', mockFetchOk());
      const result = await runEmailTick(db, AT_GATE);
      expect(result.meetingId).toBe(meetingId);
      expect(result.draftsCreated).toBe(2);
    });

    it('after 16:45 CT with an attended meeting: compiles drafts (leadership_report + visitor_thankyou)', async () => {
      vi.stubGlobal('fetch', mockFetchOk());
      const result = await runEmailTick(db, AFTER_GATE_BEFORE_SEND);
      expect(result.meetingId).toBe(meetingId);
      expect(result.draftsCreated).toBe(2);
      // Same tick also fires the one-time approval notice (approveMode
      // default ON) — filter it out here; it's covered by its own describe
      // block below.
      const draftRows = (await messagesFor()).filter((r) => r.type !== 'approval_notice');
      expect(draftRows).toHaveLength(2);
      expect(draftRows.every((r) => r.state === 'awaiting_approval')).toBe(true); // approveMode default ON
    });

    it('a meetings row that exists but has zero attendance never triggers compilation', async () => {
      const [emptyMeeting] = await db.insert(meetings).values({
        meetingDate: '2026-08-19', startsAt: new Date('2026-08-19T20:30:00Z'),
      }).returning();

      vi.stubGlobal('fetch', mockFetchOk());
      const result = await runEmailTick(db, new Date('2026-08-19T22:00:00Z')); // 17:00 CT, gate passed
      expect(result.meetingId).toBeNull();
      const rows = await db.select().from(emailMessages).where(eq(emailMessages.meetingId, emptyMeeting.id));
      expect(rows).toHaveLength(0);
    });

    it('no meeting row at all for today never triggers compilation', async () => {
      vi.stubGlobal('fetch', mockFetchOk());
      // A Wednesday with no check-ins yet at all — nothing in `meetings` for this date.
      const result = await runEmailTick(db, new Date('2026-08-26T22:00:00Z'));
      expect(result.meetingId).toBeNull();
      expect(result.draftsCreated).toBe(0);
    });
  });

  describe('full-tick idempotency', () => {
    it('two consecutive full ticks produce identical DB state and exactly one send per due message', async () => {
      await db.update(settings).set({ approveMode: false }).where(eq(settings.id, 1));
      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      const first = await runEmailTick(db, AFTER_ALL_SEND);
      expect(first.draftsCreated).toBe(2);
      expect(first.draftsSkipped).toBe(0);
      expect(first.sentCount).toBe(2);
      expect(first.reapedCount).toBe(0);

      const rowsAfterFirst = await messagesFor();
      expect(rowsAfterFirst).toHaveLength(2);
      expect(rowsAfterFirst.every((r) => r.state === 'sent')).toBe(true);

      const second = await runEmailTick(db, AFTER_ALL_SEND);
      expect(second.draftsCreated).toBe(0);
      expect(second.draftsSkipped).toBe(2);
      expect(second.sentCount).toBe(0);
      expect(second.reapedCount).toBe(0);

      const rowsAfterSecond = await messagesFor();
      expect(rowsAfterSecond).toEqual(rowsAfterFirst); // identical DB state, down to the timestamps
      expect(fetchMock).toHaveBeenCalledTimes(2); // exactly one send per due message, total across both ticks
    });
  });

  describe('approve-mode "drafts ready to approve" notice', () => {
    it('fires exactly once, even across repeated ticks', async () => {
      const fetchMock = mockFetchOk('notice-1');
      vi.stubGlobal('fetch', fetchMock);

      const first = await runEmailTick(db, AFTER_GATE_BEFORE_SEND);
      expect(first.approvalNoticeSent).toBe(true);

      const notices = await messagesFor('approval_notice');
      expect(notices).toHaveLength(1);
      expect(notices[0].state).toBe('sent');
      expect(notices[0].recipients).toEqual(['barriosj4@gmail.com']);
      expect(notices[0].sendKey).toBe(`${meetingId}:approval_notice`);
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the notice — nothing else is due yet

      const second = await runEmailTick(db, AFTER_GATE_BEFORE_SEND);
      expect(second.approvalNoticeSent).toBe(false); // already sent — never re-fires
      expect(await messagesFor('approval_notice')).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1); // no extra network call on the second tick
    });

    it('never fires when approve-mode is off', async () => {
      await db.update(settings).set({ approveMode: false }).where(eq(settings.id, 1));
      vi.stubGlobal('fetch', mockFetchOk());
      const result = await runEmailTick(db, AFTER_GATE_BEFORE_SEND);
      expect(result.approvalNoticeSent).toBe(false);
      expect(await messagesFor('approval_notice')).toHaveLength(0);
    });

    it('SAFE_MODE still applies to the notice even though the recipient is already the owner', async () => {
      vi.stubEnv('EMAIL_SAFE_MODE', undefined); // default ON
      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      await runEmailTick(db, AFTER_GATE_BEFORE_SEND);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toEqual(['barriosj4@gmail.com']);
      expect(body.subject).toContain('[SAFE→barriosj4@gmail.com]');
    });
  });
});

describe('lib/emails/engine: reapStaleSending', () => {
  let db: TestDb;
  let meetingId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    await registerVisitor(db, {
      fullName: 'Dana Visitor', industry: 'Roofing', company: null,
      email: 'dana@example.com', phone: null, clientOpId: 'v-1', now: NOW,
    });
    const meeting = await getOrCreateMeetingFor(db, NOW);
    meetingId = meeting.id;
  });

  async function insertSending(sendKey: string, sendingAt: Date) {
    const [row] = await db.insert(emailMessages).values({
      sendKey, type: 'leadership_report', meetingId,
      recipients: ['x@example.com'], subject: 'x', state: 'sending', sendingAt,
    }).returning();
    return row;
  }

  it('reclaims a message stuck in "sending" for over 10 minutes into failed/stale-reclaimed', async () => {
    const now = new Date('2026-08-12T22:00:00Z');
    const stale = await insertSending('stale-1', new Date(now.getTime() - 15 * 60_000));

    const reclaimed = await reapStaleSending(db, now);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].id).toBe(stale.id);
    expect(reclaimed[0].state).toBe('failed');
    expect(reclaimed[0].error).toBe('stale-reclaimed');
  });

  it('leaves a fresh "sending" row (under 10 minutes) untouched', async () => {
    const now = new Date('2026-08-12T22:00:00Z');
    const fresh = await insertSending('fresh-1', new Date(now.getTime() - 2 * 60_000));

    const reclaimed = await reapStaleSending(db, now);
    expect(reclaimed).toHaveLength(0);
    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, fresh.id));
    expect(row.state).toBe('sending');
  });

  it('is a no-op the second time (state-guarded UPDATE — nothing left to reclaim)', async () => {
    const now = new Date('2026-08-12T22:00:00Z');
    await insertSending('stale-2', new Date(now.getTime() - 20 * 60_000));

    const first = await reapStaleSending(db, now);
    expect(first).toHaveLength(1);
    const second = await reapStaleSending(db, now);
    expect(second).toHaveLength(0);
  });

  it('never touches sent/failed/scheduled rows regardless of age', async () => {
    const now = new Date('2026-08-12T22:00:00Z');
    const old = new Date(now.getTime() - 60 * 60_000);
    await db.insert(emailMessages).values([
      {
        sendKey: 'already-sent', type: 'leadership_report', meetingId,
        recipients: ['x@example.com'], subject: 'x', state: 'sent', sentAt: old,
      },
      {
        sendKey: 'already-scheduled', type: 'leadership_report', meetingId,
        recipients: ['x@example.com'], subject: 'x', state: 'scheduled',
      },
    ]);

    const reclaimed = await reapStaleSending(db, now);
    expect(reclaimed).toHaveLength(0);
  });
});

describe('POST /api/cron/email-tick', () => {
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
    return new Request('http://cron.test/api/cron/email-tick', { method: 'POST', headers });
  }

  it('501s when CRON_SECRET is unset', async () => {
    vi.stubEnv('CRON_SECRET', undefined);
    const res = await tickPOST(req());
    expect(res.status).toBe(501);
  });

  it('401s when the header is missing', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret');
    const res = await tickPOST(req());
    expect(res.status).toBe(401);
  });

  it('401s when the header is wrong', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret');
    const res = await tickPOST(req({ 'x-cron-secret': 'wrong' }));
    expect(res.status).toBe(401);
  });

  it('200s and runs the tick when the header matches', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubGlobal('fetch', mockFetchOk());

    const res = await tickPOST(req({ 'x-cron-secret': 'right-secret' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('reapedCount');
    expect(body).toHaveProperty('sentCount');
  });
});
