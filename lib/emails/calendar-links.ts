// Pure URL builders for the RSVP confirmation page's "add to my calendar"
// buttons (Phase 2 Task 6 CALENDAR addendum) — Google's TEMPLATE render URL
// and Outlook.com's deeplink compose URL. No DB access, no network; the
// third calendar action (a downloadable .ics) is served by app/api/ics/
// route.ts using lib/emails/ics.ts's generateMeetingIcs directly, not this
// module — that route is deliberately token-independent ("public brand
// info", per the plan), whereas these two DO take the specific meeting date
// a given RSVP token targets, since the confirmation page already commits to
// describing that one meeting ("You're on the list for Wednesday, {date}").
//
// Same meeting facts as lib/emails/ics.ts (MEETING_START_TIME, a 60-minute
// duration, the same summary/location/description strings) — reusing its
// exported addMinutesToHhmm/utcTimeStamp keeps all three calendar surfaces
// (ics download, Google, Outlook) describing the identical event.

import { MEETING_START_TIME, chicagoTimeToUtc } from '@/lib/time';
import {
  MEETING_SUMMARY, MEETING_LOCATION, MEETING_DESCRIPTION, addMinutesToHhmm, utcTimeStamp,
} from './ics';

const MEETING_DURATION_MINUTES = 60;

function meetingWindowUtc(dateStr: string): { start: Date; end: Date } {
  const start = chicagoTimeToUtc(dateStr, MEETING_START_TIME);
  const end = chicagoTimeToUtc(dateStr, addMinutesToHhmm(MEETING_START_TIME, MEETING_DURATION_MINUTES));
  return { start, end };
}

// https://calendar.google.com/calendar/render?action=TEMPLATE&... — no auth,
// no API key; opens Google Calendar's own "add event" UI pre-filled, which
// the user still has to confirm themselves.
export function googleCalendarUrl(dateStr: string): string {
  const { start, end } = meetingWindowUtc(dateStr);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: MEETING_SUMMARY,
    dates: `${utcTimeStamp(start)}/${utcTimeStamp(end)}`,
    details: MEETING_DESCRIPTION,
    location: MEETING_LOCATION,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// https://outlook.live.com/calendar/0/deeplink/compose — Outlook.com's
// personal-calendar compose deeplink (rru=addevent). Dates as plain ISO
// instants (Outlook's deeplink accepts these directly; no YYYYMMDDT…Z
// reformatting needed the way Google's `dates` param requires).
export function outlookCalendarUrl(dateStr: string): string {
  const { start, end } = meetingWindowUtc(dateStr);
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: MEETING_SUMMARY,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    location: MEETING_LOCATION,
    body: MEETING_DESCRIPTION,
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}
