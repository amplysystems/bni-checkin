import { describe, it, expect } from 'vitest';
import { googleCalendarUrl, outlookCalendarUrl } from '@/lib/emails/calendar-links';

// 2026-08-19 is a Wednesday, CDT (America/Chicago is UTC-5 in August), so
// 15:30 CT = 20:30 UTC / 16:30 CT = 21:30 UTC — same fixture-date family as
// tests/emails-ics.test.ts.

describe('googleCalendarUrl', () => {
  it('is a TEMPLATE render URL with the correct UTC dates range', () => {
    const url = googleCalendarUrl('2026-08-19');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(parsed.searchParams.get('action')).toBe('TEMPLATE');
    expect(parsed.searchParams.get('dates')).toBe('20260819T203000Z/20260819T213000Z');
    expect(parsed.searchParams.get('text')).toBe('BNI Wheeling weekly meeting');
    expect(parsed.searchParams.get('location')).toContain('Devon Bank');
  });
});

describe('outlookCalendarUrl', () => {
  it('is an Outlook.com deeplink compose URL with ISO start/end instants', () => {
    const url = outlookCalendarUrl('2026-08-19');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://outlook.live.com/calendar/0/deeplink/compose');
    expect(parsed.searchParams.get('rru')).toBe('addevent');
    expect(parsed.searchParams.get('startdt')).toBe('2026-08-19T20:30:00.000Z');
    expect(parsed.searchParams.get('enddt')).toBe('2026-08-19T21:30:00.000Z');
    expect(parsed.searchParams.get('subject')).toBe('BNI Wheeling weekly meeting');
  });
});
