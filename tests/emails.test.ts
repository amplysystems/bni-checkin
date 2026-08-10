import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { emailMessages, settings } from '@/db/schema';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { registerVisitor } from '@/lib/visitors';
import {
  createDrafts, approve, sendNow, executeDue, EngineError,
} from '@/lib/emails/engine';

// Wednesday 2026-08-12, 14:00 CT (well before the 15:30 meeting start and
// well before either default send time). Default settings (from
// scripts/seed.ts's column defaults, spec §5 as of migration 0003):
// approveMode=true, reportSendTime='17:30' CT, thankyouSendTime='17:00' CT.
const NOW = new Date('2026-08-12T19:00:00Z');
const BEFORE_THANKYOU_TIME = new Date('2026-08-12T21:00:00Z'); // 16:00 CT — before 17:00 CT
const AFTER_THANKYOU_TIME = new Date('2026-08-12T23:00:00Z'); // 18:00 CT — after 17:00 CT

function mockFetchOk(id = 'resend-1') {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id }), text: async () => '' });
}
function mockFetchFail(status = 500, body = 'boom') {
  return vi.fn().mockResolvedValue({ ok: false, status, text: async () => body });
}

describe('lib/emails/engine', () => {
  let db: TestDb;
  let meetingId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
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

  async function messagesFor(type?: 'leadership_report' | 'visitor_thankyou') {
    const rows = await db.select().from(emailMessages).where(eq(emailMessages.meetingId, meetingId));
    return type ? rows.filter((r) => r.type === type) : rows;
  }

  describe('createDrafts', () => {
    it('creates one leadership_report and one visitor_thankyou for a present emailed visitor', async () => {
      const { created, skipped } = await createDrafts(db, meetingId);
      expect(skipped).toBe(0);
      expect(created).toHaveLength(2);
      const types = created.map((m) => m.type).sort();
      expect(types).toEqual(['leadership_report', 'visitor_thankyou']);
    });

    it('approveMode ON (default) lands new drafts in awaiting_approval', async () => {
      const { created } = await createDrafts(db, meetingId);
      expect(created.every((m) => m.state === 'awaiting_approval')).toBe(true);
    });

    it('approveMode OFF lands new drafts straight in scheduled', async () => {
      await db.update(settings).set({ approveMode: false }).where(eq(settings.id, 1));
      const { created } = await createDrafts(db, meetingId);
      expect(created.every((m) => m.state === 'scheduled')).toBe(true);
    });

    it('is idempotent: a second call creates nothing new and skips existing rows', async () => {
      const first = await createDrafts(db, meetingId);
      expect(first.created).toHaveLength(2);

      const second = await createDrafts(db, meetingId);
      expect(second.created).toHaveLength(0);
      expect(second.skipped).toBe(2);

      const rows = await messagesFor();
      expect(rows).toHaveLength(2); // still exactly 2 rows, no duplicates
    });
  });

  describe('approve', () => {
    it('before the scheduled time: moves to scheduled, stamps approval, does not send', async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;

      const updated = await approve(db, thankyou.id, 'admin:jason@example.com', BEFORE_THANKYOU_TIME);
      expect(updated?.state).toBe('scheduled');
      expect(updated?.approvedBy).toBe('admin:jason@example.com');
      expect(updated?.approvedAt).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('after the scheduled time: sends immediately', async () => {
      const fetchMock = mockFetchOk('sent-after-time');
      vi.stubGlobal('fetch', fetchMock);

      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;

      const updated = await approve(db, thankyou.id, 'admin:jason@example.com', AFTER_THANKYOU_TIME);
      expect(updated?.state).toBe('sent');
      expect(updated?.providerMessageId).toBe('sent-after-time');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never-approved messages never send: still awaiting_approval with no fetch calls made', async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);
      await createDrafts(db, meetingId);
      // Nobody called approve() — simulate time passing and the scheduler
      // running: executeDue only picks up 'scheduled' rows, never
      // 'awaiting_approval' ones.
      await executeDue(db, AFTER_THANKYOU_TIME);
      const rows = await messagesFor();
      expect(rows.every((r) => r.state === 'awaiting_approval')).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws not_awaiting_approval for a message not in that state', async () => {
      await db.update(settings).set({ approveMode: false }).where(eq(settings.id, 1));
      const { created } = await createDrafts(db, meetingId); // lands in 'scheduled'
      const err = await approve(db, created[0].id, 'admin:x', NOW).catch((e) => e);
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('not_awaiting_approval');
    });

    it('throws message_not_found for an unknown id', async () => {
      const err = await approve(db, '00000000-0000-0000-0000-000000000000', 'admin:x', NOW).catch((e) => e);
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('message_not_found');
    });

    it('throws meeting_not_found for a message with no meetingId', async () => {
      const [orphan] = await db.insert(emailMessages).values({
        sendKey: 'orphan:leadership_report', type: 'leadership_report', meetingId: null,
        recipients: ['x@example.com'], subject: 'x', state: 'awaiting_approval',
      }).returning();
      const err = await approve(db, orphan.id, 'admin:x', NOW).catch((e) => e);
      expect(err).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('meeting_not_found');
    });
  });

  describe('sendNow', () => {
    it('sends immediately from draft state, bypassing approval entirely', async () => {
      const fetchMock = mockFetchOk('sendnow-1');
      vi.stubGlobal('fetch', fetchMock);
      const { created } = await createDrafts(db, meetingId); // awaiting_approval by default
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;

      const result = await sendNow(db, thankyou.id, 'admin:jason@example.com', NOW);
      expect(result?.state).toBe('sent');
      expect(result?.providerMessageId).toBe('sendnow-1');
    });

    it('is a no-op when the message is already sent (spec §6: no re-send without an explicit revision)', async () => {
      const fetchMock = mockFetchOk('first-send');
      vi.stubGlobal('fetch', fetchMock);
      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;
      const first = await sendNow(db, thankyou.id, 'admin:a', NOW);
      expect(first?.state).toBe('sent');

      fetchMock.mockClear();
      const second = await sendNow(db, thankyou.id, 'admin:b', NOW);
      expect(second?.state).toBe('sent');
      expect(second?.providerMessageId).toBe('first-send'); // unchanged
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is a no-op while a message is mid-send ("sending")', async () => {
      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;
      await db.update(emailMessages).set({ state: 'sending' }).where(eq(emailMessages.id, thankyou.id));

      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);
      const result = await sendNow(db, thankyou.id, 'admin:a', NOW);
      expect(result?.state).toBe('sending');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('double-send is structurally impossible: two concurrent sendNow calls result in exactly one network send', async () => {
      const fetchMock = mockFetchOk('race-winner');
      vi.stubGlobal('fetch', fetchMock);
      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;

      const results = await Promise.allSettled([
        sendNow(db, thankyou.id, 'admin:a', NOW),
        sendNow(db, thankyou.id, 'admin:b', NOW),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [final] = await db.select().from(emailMessages).where(eq(emailMessages.id, thankyou.id));
      expect(final.state).toBe('sent');
      expect(final.providerMessageId).toBe('race-winner');
    });
  });

  describe('executeDue', () => {
    it('sends scheduled messages whose time has passed and leaves not-yet-due ones alone', async () => {
      await db.update(settings).set({ approveMode: false }).where(eq(settings.id, 1));
      const { created } = await createDrafts(db, meetingId); // all land in 'scheduled'
      expect(created.every((m) => m.state === 'scheduled')).toBe(true);

      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      const sentNotDue = await executeDue(db, BEFORE_THANKYOU_TIME);
      expect(sentNotDue).toHaveLength(0); // neither send time (17:00, 17:30) has passed yet at 16:00 CT

      const sentDue = await executeDue(db, AFTER_THANKYOU_TIME); // 18:00 CT: thank-you (17:00) due, report (17:30) due
      expect(sentDue.length).toBe(2);
      expect(sentDue.every((m) => m.state === 'sent')).toBe(true);
    });

    it('is idempotent: running it twice after the due time only sends once per message', async () => {
      await db.update(settings).set({ approveMode: false }).where(eq(settings.id, 1));
      await createDrafts(db, meetingId);
      const fetchMock = mockFetchOk();
      vi.stubGlobal('fetch', fetchMock);

      const firstRun = await executeDue(db, AFTER_THANKYOU_TIME);
      expect(firstRun).toHaveLength(2);
      const secondRun = await executeDue(db, AFTER_THANKYOU_TIME);
      expect(secondRun).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry and failure recording', () => {
    it('retries a transient failure and succeeds within the same call, leaving no failed state behind', async () => {
      let calls = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls < 3) return { ok: false, status: 500, text: async () => 'transient' };
        return { ok: true, json: async () => ({ id: 'succeeded-on-3rd' }) };
      });
      vi.stubGlobal('fetch', fetchMock);

      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;
      const result = await sendNow(db, thankyou.id, 'admin:a', NOW);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result?.state).toBe('sent');
      expect(result?.providerMessageId).toBe('succeeded-on-3rd');
      expect(result?.error).toBeNull();
    });

    it('after 3 consecutive failures, records state=failed with the error message', async () => {
      const fetchMock = mockFetchFail(503, 'persistent outage');
      vi.stubGlobal('fetch', fetchMock);

      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;
      const result = await sendNow(db, thankyou.id, 'admin:a', NOW);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result?.state).toBe('failed');
      expect(result?.error).toContain('Failed after 3 attempts');
      expect(result?.error).toContain('503');
    });

    it('a failed message can be retried later via sendNow (a manual nudge past the automatic retries)', async () => {
      const failing = mockFetchFail(500, 'down');
      vi.stubGlobal('fetch', failing);
      const { created } = await createDrafts(db, meetingId);
      const thankyou = created.find((m) => m.type === 'visitor_thankyou')!;
      const failedResult = await sendNow(db, thankyou.id, 'admin:a', NOW);
      expect(failedResult?.state).toBe('failed');

      const recovering = mockFetchOk('recovered');
      vi.stubGlobal('fetch', recovering);
      const recovered = await sendNow(db, thankyou.id, 'admin:a', NOW);
      expect(recovered?.state).toBe('sent');
      expect(recovered?.providerMessageId).toBe('recovered');
    });
  });
});
