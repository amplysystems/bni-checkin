// Public .ics download for the RSVP page's "add to my calendar" actions
// (Phase 2 Task 6 CALENDAR addendum). Deliberately token-independent — "the
// next-meeting invite... no token needed, it's public brand info" per the
// plan: this always describes the literal next Wednesday from whenever
// it's requested (generateMeetingIcs's default `now`), not any specific
// visitor's targeted meeting date. No auth, no DB access.

import { generateMeetingIcs } from '@/lib/emails/ics';

export async function GET() {
  const ics = generateMeetingIcs();
  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="bni-wheeling-meeting.ics"',
      'Cache-Control': 'no-store',
    },
  });
}
