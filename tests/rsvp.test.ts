import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { people, rsvpTokens, emailMessages } from '@/db/schema';
import {
  isValidTokenFormat, getOrCreateRsvpToken, findRsvpToken, markRsvpTokenUsed,
} from '@/lib/emails/rsvp-tokens';
import { resolveRsvpVisit } from '@/lib/rsvp-visit';
import { rsvpNoticeSendKey } from '@/lib/emails/send-keys';

function mockFetchOk(id = 'resend-1') {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id }), text: async () => '' });
}

describe('lib/emails/rsvp-tokens', () => {
  let db: TestDb;
  let personId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    const [p] = await db.insert(people).values({ fullName: 'Val Visitor', email: 'val@example.com' }).returning();
    personId = p.id;
  });

  describe('isValidTokenFormat', () => {
    it('accepts a well-formed v4 UUID', () => {
      expect(isValidTokenFormat('11111111-2222-4333-8444-555555555555')).toBe(true);
    });
    it('rejects garbage, empty, and near-miss strings', () => {
      expect(isValidTokenFormat('not-a-token')).toBe(false);
      expect(isValidTokenFormat('')).toBe(false);
      expect(isValidTokenFormat('11111111-2222-4333-8444-55555555555')).toBe(false); // one char short
    });
  });

  describe('getOrCreateRsvpToken', () => {
    it('creates a new token for a fresh person+purpose+targetDate', async () => {
      const token = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-19' });
      expect(isValidTokenFormat(token)).toBe(true);
      const rows = await db.select().from(rsvpTokens).where(eq(rsvpTokens.personId, personId));
      expect(rows).toHaveLength(1);
      expect(rows[0].purpose).toBe('rsvp');
      expect(rows[0].targetDate).toBe('2026-08-19');
    });

    it('is idempotent: a second call for the same person+purpose+targetDate reuses the same token', async () => {
      const first = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-19' });
      const second = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-19' });
      expect(second).toBe(first);
      const rows = await db.select().from(rsvpTokens).where(eq(rsvpTokens.personId, personId));
      expect(rows).toHaveLength(1);
    });

    it('a different purpose (or targetDate) for the same person gets its own token', async () => {
      const rsvp = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-19' });
      const interest = await getOrCreateRsvpToken(db, { personId, purpose: 'interest', targetDate: '2026-08-19' });
      const laterWeek = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-26' });
      expect(new Set([rsvp, interest, laterWeek]).size).toBe(3);
    });
  });

  describe('findRsvpToken', () => {
    it('returns null for a malformed token without querying the DB', async () => {
      expect(await findRsvpToken(db, 'not-a-uuid')).toBeNull();
    });

    it('returns null for a well-formed but unknown token', async () => {
      expect(await findRsvpToken(db, '11111111-2222-4333-8444-555555555555')).toBeNull();
    });

    it('returns the row plus the person\'s fullName for a known token', async () => {
      const token = await getOrCreateRsvpToken(db, { personId, purpose: 'interest', targetDate: '2026-08-19' });
      const row = await findRsvpToken(db, token);
      expect(row).not.toBeNull();
      expect(row!.purpose).toBe('interest');
      expect(row!.personFullName).toBe('Val Visitor');
      expect(row!.firstUsedAt).toBeNull();
    });
  });

  describe('markRsvpTokenUsed', () => {
    it('returns true exactly once; a second call on the same token returns false', async () => {
      const token = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-19' });
      const first = await markRsvpTokenUsed(db, token);
      const second = await markRsvpTokenUsed(db, token);
      expect(first).toBe(true);
      expect(second).toBe(false);
      const [row] = await db.select().from(rsvpTokens).where(eq(rsvpTokens.token, token));
      expect(row.firstUsedAt).toBeTruthy();
    });

    it('two concurrent calls on a fresh token: exactly one wins', async () => {
      const token = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-19' });
      const [a, b] = await Promise.all([markRsvpTokenUsed(db, token), markRsvpTokenUsed(db, token)]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });
  });
});

describe('lib/rsvp-visit resolveRsvpVisit', () => {
  let db: TestDb;
  let personId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');
    const [p] = await db.insert(people).values({ fullName: 'Val Visitor', email: 'val@example.com' }).returning();
    personId = p.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('an invalid/unknown token resolves to status:invalid — no error codes', async () => {
    const resolution = await resolveRsvpVisit(db, 'garbage-token');
    expect(resolution).toEqual({ status: 'invalid' });
  });

  it('a valid rsvp token resolves with purpose/firstName/meetingDateLabel, and fires the owner notice exactly once', async () => {
    const fetchMock = mockFetchOk('notice-1');
    vi.stubGlobal('fetch', fetchMock);
    const token = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-19' });

    const first = await resolveRsvpVisit(db, token);
    expect(first).toMatchObject({
      status: 'valid', purpose: 'rsvp', firstName: 'Val', targetDateStr: '2026-08-19',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [notice] = await db.select().from(emailMessages).where(eq(emailMessages.sendKey, rsvpNoticeSendKey(token)));
    expect(notice.type).toBe('rsvp_notice');
    expect(notice.state).toBe('sent');
    expect(notice.subject).toBe('Val Visitor plans to visit Wednesday');
    expect(notice.recipients).toEqual(['barriosj4@gmail.com']);

    // Second view of the SAME token: still resolves fine, but does NOT
    // re-notify — no second fetch call, no second email_messages row.
    const second = await resolveRsvpVisit(db, token);
    expect(second.status).toBe('valid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const allNotices = await db.select().from(emailMessages).where(eq(emailMessages.sendKey, rsvpNoticeSendKey(token)));
    expect(allNotices).toHaveLength(1);
  });

  it('a valid interest token fires the membership-interest notice subject', async () => {
    const fetchMock = mockFetchOk('notice-2');
    vi.stubGlobal('fetch', fetchMock);
    const token = await getOrCreateRsvpToken(db, { personId, purpose: 'interest', targetDate: '2026-08-19' });

    const resolution = await resolveRsvpVisit(db, token);
    expect(resolution).toMatchObject({ status: 'valid', purpose: 'interest', firstName: 'Val' });

    const [notice] = await db.select().from(emailMessages).where(eq(emailMessages.sendKey, rsvpNoticeSendKey(token)));
    expect(notice.subject).toBe('Val Visitor is interested in membership');
  });

  // P2-6 carry-in (Task 8): a link opened after its named Wednesday has
  // already come and gone.
  describe('targetDate < today ("passed")', () => {
    it('recomputes meetingDateLabel/targetDateStr to the next real meeting and sets passed:true', async () => {
      vi.stubGlobal('fetch', mockFetchOk('notice-passed-1'));
      // Token names a meeting date well in the past relative to `now` below.
      const token = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-05' });
      const now = new Date('2026-08-12T19:00:00Z'); // Wednesday 2026-08-12, 14:00 CT

      const resolution = await resolveRsvpVisit(db, token, now);
      expect(resolution).toMatchObject({ status: 'valid', purpose: 'rsvp', passed: true });
      if (resolution.status !== 'valid') throw new Error('expected valid');
      // Next Wednesday from `now` (itself a Wednesday, before meeting start) is TODAY.
      expect(resolution.targetDateStr).toBe('2026-08-12');
      expect(resolution.meetingDateLabel).toContain('August 12, 2026');
    });

    it('does not mark a still-upcoming targetDate as passed', async () => {
      vi.stubGlobal('fetch', mockFetchOk('notice-passed-2'));
      const token = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-19' });
      const now = new Date('2026-08-12T19:00:00Z');

      const resolution = await resolveRsvpVisit(db, token, now);
      expect(resolution).toMatchObject({ status: 'valid', passed: false, targetDateStr: '2026-08-19' });
    });

    it('an interest token past its targetDate also gets passed:true (the meeting-details card still needs a real date)', async () => {
      vi.stubGlobal('fetch', mockFetchOk('notice-passed-3'));
      const token = await getOrCreateRsvpToken(db, { personId, purpose: 'interest', targetDate: '2026-08-05' });
      const now = new Date('2026-08-12T19:00:00Z');

      const resolution = await resolveRsvpVisit(db, token, now);
      expect(resolution).toMatchObject({ status: 'valid', purpose: 'interest', passed: true, targetDateStr: '2026-08-12' });
    });
  });
});
