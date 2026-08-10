import { fromZonedTime } from 'date-fns-tz';

export const CHAPTER_TZ = 'America/Chicago';
// Exported (Phase 1 had this private) so Phase 2's email engine can share
// the exact same meeting-start wall-clock time — lib/emails/ics.ts's VEVENT
// DTSTART and lib/emails/engine.ts's schedule-time math both need it, and a
// single source of truth means the "meeting starts 15:30 CT" fact can never
// drift between the two.
export const MEETING_START_TIME = '15:30';

export function chicagoDateString(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CHAPTER_TZ }).format(now);
}

// General Chicago-local "HH:MM" wall-clock time -> UTC instant conversion,
// DST-safe by construction (fromZonedTime resolves the correct offset for
// the given calendar date). meetingStartUtc is just this pinned to the
// meeting's own start time; the email engine reuses the general form for
// settings.reportSendTime / settings.thankyouSendTime.
export function chicagoTimeToUtc(dateStr: string, hhmm: string): Date {
  return fromZonedTime(`${dateStr} ${hhmm}`, CHAPTER_TZ);
}

export function meetingStartUtc(dateStr: string): Date {
  return chicagoTimeToUtc(dateStr, MEETING_START_TIME);
}

// Chicago wall-clock breakdown of an instant — weekday (0=Sun..6=Sat), hour
// (0-23) and minute. Used by lib/emails/ics.ts's nextWednesday() to decide
// same-day-vs-next-week without re-deriving Intl formatting logic there.
export function chicagoWallClock(now: Date): { dateStr: string; weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHAPTER_TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateStr: chicagoDateString(now),
    weekday: weekdayMap[get('weekday')] ?? 0,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

export function greetingFor(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: CHAPTER_TZ, hour: 'numeric', hourCycle: 'h23',
  }).format(now));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
