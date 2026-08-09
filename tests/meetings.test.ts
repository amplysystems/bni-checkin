import { describe, it, expect } from 'vitest';
import { chicagoDateString, greetingFor, meetingStartUtc } from '@/lib/time';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { createTestDb } from './helpers/db';

describe('time helpers (America/Chicago)', () => {
  it('computes the local date across the UTC boundary', () => {
    expect(chicagoDateString(new Date('2026-08-13T03:00:00Z'))).toBe('2026-08-12');
  });
  it('computes 3:30 PM CT in summer (CDT, UTC-5)', () => {
    expect(meetingStartUtc('2026-08-12').toISOString()).toBe('2026-08-12T20:30:00.000Z');
  });
  it('computes 3:30 PM CT in winter (CST, UTC-6)', () => {
    expect(meetingStartUtc('2026-12-16').toISOString()).toBe('2026-12-16T21:30:00.000Z');
  });
  it('greets by Chicago local time of day', () => {
    expect(greetingFor(new Date('2026-08-12T20:00:00Z'))).toBe('Good afternoon');
    expect(greetingFor(new Date('2026-08-12T13:00:00Z'))).toBe('Good morning');
    expect(greetingFor(new Date('2026-08-13T00:30:00Z'))).toBe('Good evening');
  });
});

describe('getOrCreateMeetingFor', () => {
  it('creates one meeting per Chicago date and returns the same row on repeat calls', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-12T19:00:00Z');
    const a = await getOrCreateMeetingFor(db, now);
    const b = await getOrCreateMeetingFor(db, now);
    expect(a.id).toBe(b.id);
    expect(a.meetingDate).toBe('2026-08-12');
  });
});
