// Pure VEVENT/VCALENDAR generator for the visitor thank-you emails'
// calendar attachment (Phase 2 CALENDAR addendum, Jason 2026-08-10). No DB
// access, no network — deterministic string building only, so this is
// cheap to unit test in isolation from the send pipeline. lib/emails/
// send.ts is the only caller; it base64-encodes the output for Resend's
// attachments field.
//
// Deliberately NOT recurring: every week gets its own standalone VEVENT
// for that Wednesday's date only (regenerated fresh at send time — see
// send.ts). A recurring RRULE would silently carry forward through a
// canceled/rescheduled week; single non-recurring events keep
// cancellations honest, per the plan.
//
// TZID convention: DTSTART/DTEND use `;TZID=America/Chicago:` floating
// local time WITHOUT an embedded VTIMEZONE component. Strictly, RFC 5545
// wants a VTIMEZONE block defining the IANA zone's offset/DST rules; in
// practice every mainstream client (Gmail, Apple Calendar, Outlook.com/
// desktop) resolves well-known IANA TZIDs directly and renders the correct
// wall-clock time without one. A full VTIMEZONE (with its own RRULE for
// DST transitions) is meaningful extra surface for a single-event,
// non-recurring invite — skipped here; revisit if a recipient's client
// ever mis-renders the time.

import { CHAPTER_TZ, MEETING_START_TIME, chicagoWallClock } from '@/lib/time';

export const MEETING_SUMMARY = 'BNI Wheeling weekly meeting';
export const MEETING_LOCATION = 'Devon Bank, 561 N Milwaukee Ave, Wheeling, IL 60090';
export const MEETING_DESCRIPTION =
  "You're invited to BNI Wheeling's weekly meeting. Reply to the thank-you email to let us know you're coming, or just show up — guests are always welcome.";

const MEETING_DURATION_MINUTES = 60;
const CRLF = '\r\n';

// Days from `weekday` (0=Sun..6=Sat) to the next Wednesday (3); 0 exactly
// when `weekday` IS Wednesday.
function daysUntilWednesday(weekday: number): number {
  return (3 - weekday + 7) % 7;
}

// Pure calendar-date arithmetic (Date.UTC on the Y/M/D components) rather
// than adding real elapsed time to `from` — this keeps "add N calendar
// days" correct regardless of the caller's timezone or any DST transition
// the span crosses, since it never touches a wall-clock hour at all.
function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Chicago-date-aware "next Wednesday" — decision (documented per the task):
// from a non-Wednesday, it's simply the upcoming Wednesday's date. FROM a
// Wednesday, "next meeting" is TODAY if called before the 3:30 PM CT
// meeting start, otherwise the meeting already underway isn't "next"
// anymore and this rolls to the following week. The boundary is exclusive
// of the start minute itself (15:30:00 sharp counts as "started").
export function nextWednesday(from: Date): string {
  const wall = chicagoWallClock(from);
  const days = daysUntilWednesday(wall.weekday);
  if (days > 0) return addDaysToDateString(wall.dateStr, days);

  const [meetingHour, meetingMinute] = MEETING_START_TIME.split(':').map(Number);
  const beforeMeetingStart =
    wall.hour < meetingHour || (wall.hour === meetingHour && wall.minute < meetingMinute);
  return beforeMeetingStart ? wall.dateStr : addDaysToDateString(wall.dateStr, 7);
}

// RFC 5545 §3.3.11 TEXT escaping: backslash first (so the escapes just
// introduced below aren't themselves re-escaped), then comma/semicolon,
// then literal newlines collapsed to the two-character "\n" sequence.
function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function localDateTimeStamp(dateStr: string, hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return `${dateStr.replace(/-/g, '')}T${h.padStart(2, '0')}${m.padStart(2, '0')}00`;
}

function addMinutesToHhmm(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function utcTimeStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export type MeetingIcsInput = {
  now?: Date;
  // Overrides the computed next-Wednesday date. Mainly for callers that
  // already know the exact meeting a draft/send is for (compile.ts knows
  // the meetingId's real date) and shouldn't have nextWednesday() re-derive
  // it from wall-clock time at a slightly different instant.
  meetingDateStr?: string;
};

export function generateMeetingIcs(input: MeetingIcsInput = {}): string {
  const now = input.now ?? new Date();
  const dateStr = input.meetingDateStr ?? nextWednesday(now);
  const startLocal = localDateTimeStamp(dateStr, MEETING_START_TIME);
  const endLocal = localDateTimeStamp(dateStr, addMinutesToHhmm(MEETING_START_TIME, MEETING_DURATION_MINUTES));
  // Deterministic per-date UID (not random): re-generating the ics for the
  // same target meeting date — e.g. the v1 and v2 thank-you both attach one
  // for the same upcoming Wednesday — produces the identical UID, so a
  // recipient's calendar app treats a second copy as the same event rather
  // than a duplicate entry.
  const uid = `bni-wheeling-${dateStr}@amplysystems.com`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Amply Systems//BNI Wheeling Check-in//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcTimeStamp(now)}`,
    `DTSTART;TZID=${CHAPTER_TZ}:${startLocal}`,
    `DTEND;TZID=${CHAPTER_TZ}:${endLocal}`,
    `SUMMARY:${escapeIcsText(MEETING_SUMMARY)}`,
    `LOCATION:${escapeIcsText(MEETING_LOCATION)}`,
    `DESCRIPTION:${escapeIcsText(MEETING_DESCRIPTION)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join(CRLF) + CRLF;
}
