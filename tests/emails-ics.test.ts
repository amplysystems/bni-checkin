import { describe, it, expect } from 'vitest';
import {
  nextWednesday, generateMeetingIcs, MEETING_SUMMARY, MEETING_LOCATION,
} from '@/lib/emails/ics';

// 2026-08-12 is a Wednesday (verified against the same fixture date used
// throughout tests/checkins.test.ts). 2026-08-19 is the following one.
// August sits in CDT (America/Chicago is UTC-5), so 15:30 CT = 20:30 UTC.

describe('nextWednesday', () => {
  it('from a non-Wednesday returns the upcoming Wednesday, same week', () => {
    // Monday 2026-08-10, mid-morning
    expect(nextWednesday(new Date('2026-08-10T15:00:00Z'))).toBe('2026-08-12');
  });

  it('from a Sunday returns the Wednesday 3 days later', () => {
    expect(nextWednesday(new Date('2026-08-09T15:00:00Z'))).toBe('2026-08-12');
  });

  it('from Thursday (the day after a Wednesday meeting) returns next week', () => {
    expect(nextWednesday(new Date('2026-08-13T15:00:00Z'))).toBe('2026-08-19');
  });

  it('on a Wednesday BEFORE 15:30 CT returns today', () => {
    // 20:29 UTC = 15:29 CT
    expect(nextWednesday(new Date('2026-08-12T20:29:00Z'))).toBe('2026-08-12');
  });

  it('on a Wednesday AT exactly 15:30 CT rolls to next week (boundary is exclusive)', () => {
    // 20:30:00 UTC = 15:30:00 CT sharp
    expect(nextWednesday(new Date('2026-08-12T20:30:00Z'))).toBe('2026-08-19');
  });

  it('on a Wednesday AFTER 15:30 CT rolls to next week', () => {
    // 21:00 UTC = 16:00 CT
    expect(nextWednesday(new Date('2026-08-12T21:00:00Z'))).toBe('2026-08-19');
  });

  it('very early on a Wednesday morning (well before the meeting) still returns today', () => {
    // 13:00 UTC = 08:00 CT
    expect(nextWednesday(new Date('2026-08-12T13:00:00Z'))).toBe('2026-08-12');
  });
});

describe('generateMeetingIcs', () => {
  it('uses CRLF line endings throughout', () => {
    const ics = generateMeetingIcs({ now: new Date('2026-08-10T15:00:00Z') });
    expect(ics).toContain('\r\n');
    // No bare LF anywhere (every \n must be preceded by \r).
    const withoutCrlf = ics.replace(/\r\n/g, '');
    expect(withoutCrlf).not.toContain('\n');
  });

  it('wraps a single VEVENT in VCALENDAR, non-recurring (no RRULE)', () => {
    const ics = generateMeetingIcs({ now: new Date('2026-08-10T15:00:00Z') });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('RRULE');
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
  });

  it('DTSTART/DTEND carry the TZID=America/Chicago param at 15:30-16:30 on next Wednesday', () => {
    const ics = generateMeetingIcs({ now: new Date('2026-08-10T15:00:00Z') }); // Monday -> 2026-08-12
    expect(ics).toContain('DTSTART;TZID=America/Chicago:20260812T153000');
    expect(ics).toContain('DTEND;TZID=America/Chicago:20260812T163000');
  });

  it('meetingDateStr overrides the computed date', () => {
    const ics = generateMeetingIcs({ now: new Date('2026-08-10T15:00:00Z'), meetingDateStr: '2026-09-02' });
    expect(ics).toContain('DTSTART;TZID=America/Chicago:20260902T153000');
  });

  it('escapes commas and semicolons in LOCATION per RFC 5545', () => {
    const ics = generateMeetingIcs({ now: new Date('2026-08-10T15:00:00Z') });
    // MEETING_LOCATION contains real commas — confirm the raw unescaped
    // form never appears, only the backslash-escaped one.
    expect(MEETING_LOCATION).toContain(',');
    expect(ics).not.toContain(`LOCATION:${MEETING_LOCATION}`);
    expect(ics).toContain('LOCATION:Devon Bank\\, 561 N Milwaukee Ave\\, Wheeling\\, IL 60090');
  });

  it('SUMMARY is present verbatim (no special chars to escape)', () => {
    const ics = generateMeetingIcs({ now: new Date('2026-08-10T15:00:00Z') });
    expect(ics).toContain(`SUMMARY:${MEETING_SUMMARY}`);
  });

  it('includes a UID and a DTSTAMP', () => {
    const ics = generateMeetingIcs({ now: new Date('2026-08-10T15:00:00Z') });
    expect(ics).toMatch(/UID:bni-wheeling-2026-08-12@amplysystems\.com/);
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
  });

  it('the UID is stable for the same target date regardless of generation time', () => {
    const a = generateMeetingIcs({ now: new Date('2026-08-10T15:00:00Z') });
    const b = generateMeetingIcs({ now: new Date('2026-08-11T18:00:00Z') });
    const uidOf = (s: string) => s.match(/UID:([^\r\n]+)/)?.[1];
    expect(uidOf(a)).toBe(uidOf(b));
  });
});
