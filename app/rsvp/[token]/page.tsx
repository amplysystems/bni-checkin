// Public one-tap RSVP / interest-capture confirmation page (Phase 2 Task
// 6). Deliberately NO auth — the token itself IS the auth (see
// lib/emails/rsvp-tokens.ts's header comment). Server component,
// force-dynamic (every view is a live DB read + a possible first-use side
// effect via lib/rsvp-visit.ts, never something to cache/prerender).
//
// Renders ONLY a first name plus generic meeting info — no contact info, no
// full name anywhere in the markup, matching the plan's explicit
// constraint. Three states: valid 'rsvp' token (visitor thank-you v1's
// CTA), valid 'interest' token (v2 conversion's CTA — VISION-DOC ADOPTION
// (1): membership interest, not an RSVP, so no visit exists to add to a
// calendar for), and invalid/unknown (never distinguishes "expired" from
// "never existed" — see findRsvpToken's own comment on why).

import Image from 'next/image';
import { getDb } from '@/lib/db';
import { resolveRsvpVisit, type RsvpVisitResolution } from '@/lib/rsvp-visit';
import { googleCalendarUrl, outlookCalendarUrl } from '@/lib/emails/calendar-links';
import { VENUE_LINE_1, VENUE_LINE_2 } from '@/emails/visitor-thankyou';
import { MEETING_START_TIME } from '@/lib/time';

export const dynamic = 'force-dynamic';

// Same fixed dark navy as the kiosk split-rail / admin login rail
// (app/kiosk/kiosk-client.tsx's RAIL_NAVY, app/admin/login/page.tsx's own
// copy of the same literal) — duplicated rather than shared per this
// codebase's "two call sites, not three" bar for pulling something into
// components/ui (see button.tsx's docblock).
const RAIL_NAVY = '#0b0f19';
const BRAND_RED = '#CF2030';

function formatMeetingStartTime(): string {
  const [h] = MEETING_START_TIME.split(':').map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:30 PM`;
}

type ValidResolution = Extract<RsvpVisitResolution, { status: 'valid' }>;

const CALENDAR_LINK_CLASS =
  'flex min-h-[52px] items-center justify-center rounded-xl border border-white/15 bg-white/5 px-5 text-[15px] font-medium text-neutral-100 transition hover:bg-white/10';

function CalendarActions({ targetDateStr }: { targetDateStr: string }) {
  return (
    <div className="mt-8">
      <p className="mb-3 text-sm text-neutral-400">Add to my calendar</p>
      <div className="flex flex-col gap-3">
        <a
          href={googleCalendarUrl(targetDateStr)}
          target="_blank"
          rel="noreferrer"
          className={CALENDAR_LINK_CLASS}
        >
          Add with Google Calendar
        </a>
        <a
          href={outlookCalendarUrl(targetDateStr)}
          target="_blank"
          rel="noreferrer"
          className={CALENDAR_LINK_CLASS}
        >
          Add with Outlook
        </a>
        {/* Unlike the two links above (both keyed off THIS token's own
            targetDateStr), the .ics download is deliberately
            token-independent (app/api/ics/route.ts) — "public brand info,"
            per the plan: it always describes the literal next Wednesday
            from whenever it's requested, not this specific token's
            meeting. In the ordinary case (opened the same week the email
            arrived) those are the same date anyway. */}
        <a href="/api/ics" className={CALENDAR_LINK_CLASS}>
          Download calendar file (.ics)
        </a>
      </div>
    </div>
  );
}

function MeetingDetails({ meetingDateLabel }: { meetingDateLabel: string }) {
  return (
    <div className="mt-6 rounded-2xl bg-white/5 p-5 text-left">
      <p className="text-sm font-semibold text-neutral-100">BNI Wheeling &middot; weekly meeting</p>
      <p className="mt-1.5 text-sm text-neutral-300">{meetingDateLabel} &middot; {formatMeetingStartTime()}</p>
      <p className="text-sm text-neutral-300">{VENUE_LINE_1}, {VENUE_LINE_2}</p>
    </div>
  );
}

// P2-6 carry-in: a link opened after its named Wednesday has already come
// and gone (resolution.passed — see lib/rsvp-visit.ts) gets its own,
// honest headline rather than confirming a meeting that already happened.
// meetingDateLabel/targetDateStr are already recomputed to the next real
// meeting from now by the time this renders, so MeetingDetails and
// CalendarActions below need no separate "passed" branch of their own —
// they're just describing whatever date resolution actually hands them.
function ValidView({ resolution }: { resolution: ValidResolution }) {
  const headline = resolution.purpose === 'rsvp'
    ? (resolution.passed
      ? `That Wednesday has passed — here's the next one, ${resolution.firstName}`
      : `You're on the list for Wednesday, ${resolution.firstName}`)
    : `Got it, ${resolution.firstName} — Jason will reach out`;
  const subtext = resolution.purpose === 'rsvp'
    ? (resolution.passed ? "We've saved you a seat for the next one instead." : "We'll have a seat waiting for you.")
    : "He'll follow up personally — no forms to fill out.";

  return (
    <div className="mt-10">
      <h1 className="font-display text-3xl font-black leading-tight tracking-tight text-neutral-50">
        {headline}
      </h1>
      <p className="mt-3 text-neutral-300">{subtext}</p>

      <MeetingDetails meetingDateLabel={resolution.meetingDateLabel} />

      {/* Calendar actions only for an actual RSVP — an 'interest' token is
          membership interest, not attendance at a specific meeting (VISION-
          DOC ADOPTION (1): "no visit 3 exists"), so there's no meeting here
          to add to a calendar for. */}
      {resolution.purpose === 'rsvp' && <CalendarActions targetDateStr={resolution.targetDateStr} />}
    </div>
  );
}

function InvalidView() {
  return (
    <div className="mt-10">
      <h1 className="font-display text-2xl font-bold leading-snug tracking-tight text-neutral-50">
        This link has expired &mdash; ask a member for help
      </h1>
    </div>
  );
}

export default async function RsvpPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb();
  const resolution = await resolveRsvpVisit(db, token);

  return (
    <main
      className="flex min-h-screen flex-col items-center px-6 py-16"
      style={{ backgroundColor: RAIL_NAVY }}
    >
      <div className="w-full max-w-md text-center">
        <Image
          src="/bni-logo-transparent.png"
          alt="BNI"
          width={160}
          height={90}
          priority
          className="mx-auto h-10 w-auto"
        />
        <div className="mx-auto mt-2 h-[3px] w-11" style={{ backgroundColor: BRAND_RED }} />

        {resolution.status === 'invalid' ? <InvalidView /> : <ValidView resolution={resolution} />}
      </div>
    </main>
  );
}
