import { fromZonedTime } from 'date-fns-tz';

export const CHAPTER_TZ = 'America/Chicago';
const MEETING_HOUR = '15:30';

export function chicagoDateString(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CHAPTER_TZ }).format(now);
}

export function meetingStartUtc(dateStr: string): Date {
  return fromZonedTime(`${dateStr} ${MEETING_HOUR}`, CHAPTER_TZ);
}

export function greetingFor(now: Date): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: CHAPTER_TZ, hour: 'numeric', hour12: false,
  }).format(now));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
