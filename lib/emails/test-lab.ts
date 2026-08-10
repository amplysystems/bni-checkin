// Phase 2 admin "Test Lab" (System test section) — lets an admin preview or
// send THEMSELVES a real copy of every outbound template, using obviously-
// fake SAMPLE data, completely isolated from the production pipeline: no
// email_messages row is ever created here, nothing here touches
// attendance/visitors/meetings, nothing here increments anything, nothing
// here notifies leadership. app/api/admin/test-lab/route.ts is the thin
// auth+dispatch wrapper around this module, same layering as
// lib/emails/compile.ts + lib/emails/engine.ts for the real pipeline.
//
// weekly_report is the one kind that touches the database at all, and even
// then only to read + (for a meeting that actually has attendance today)
// reuse compileForMeeting — which is itself read-only except for its
// idempotent getOrCreateRsvpToken upserts on visitor drafts (see that
// function's own header comment). app/api/admin/emails' existing 'preview'
// action already accepts that exact same tradeoff for the exact same
// reason ("preview never sends anything," not "preview never touches the
// database") — this reuses the precedent rather than re-litigating it.
// Nothing here ever calls createDrafts, so email_messages is never written.
// The other three kinds (thankyou_v1, thankyou_v2, rsvp_page) touch nothing
// at all — pure string-building from the SAMPLE constants below.

import { findMeetingByDate, meetingHasAttendance } from '@/lib/meetings';
import { chicagoDateString } from '@/lib/time';
import type { Db } from '@/lib/db';
import { compileForMeeting, type LeadershipReportDraft } from './compile';
import { siteUrl } from './constants';
import { visitorThankyouSubject, visitorThankyouHtml, visitorThankyouText, VENUE_LINE_1, VENUE_LINE_2, MEETING_LINE } from '@/emails/visitor-thankyou';
import { visitorConversionSubject, visitorConversionHtml, visitorConversionText } from '@/emails/visitor-conversion';
import {
  leadershipReportHtml, leadershipReportText, leadershipReportSubject, type LeadershipReportData,
} from '@/emails/leadership-report';

export const TEST_LAB_KINDS = ['thankyou_v1', 'thankyou_v2', 'weekly_report', 'rsvp_page'] as const;
export type TestLabKind = typeof TEST_LAB_KINDS[number];

// 'rsvp_page' is preview-only — it's a page, not an email, so there's
// nothing for a "Send me a copy" action to mail out (see the admin UI's
// RSVP group, which only ever renders a Preview button, never Send).
export const TEST_LAB_SEND_KINDS = ['thankyou_v1', 'thankyou_v2', 'weekly_report'] as const;
export type TestLabSendKind = typeof TEST_LAB_SEND_KINDS[number];

export type TestLabContent = { subject: string; html: string; text: string };

// Obviously-fake sample visitor — never a real roster row, never read from
// or written to the people table.
const SAMPLE_VISITOR = {
  firstName: 'Dana',
  industry: 'CPA',
  email: 'dana@example.com',
} as const;

const SAMPLE_ACTIVE_MEMBER_COUNT = 18;

function sampleRsvpUrl(purpose: 'rsvp' | 'interest'): string {
  return `${siteUrl()}/rsvp/sample-${purpose}-preview`;
}

function thankyouV1Content(): TestLabContent {
  const { firstName } = SAMPLE_VISITOR;
  return {
    subject: visitorThankyouSubject(firstName),
    html: visitorThankyouHtml({ firstName, siteUrl: siteUrl(), rsvpUrl: sampleRsvpUrl('rsvp') }),
    text: visitorThankyouText({ firstName }),
  };
}

function thankyouV2Content(): TestLabContent {
  const { firstName, industry } = SAMPLE_VISITOR;
  return {
    subject: visitorConversionSubject(firstName, industry),
    html: visitorConversionHtml({
      firstName,
      industry,
      activeMemberCount: SAMPLE_ACTIVE_MEMBER_COUNT,
      siteUrl: siteUrl(),
      rsvpUrl: sampleRsvpUrl('interest'),
    }),
    text: visitorConversionText({ firstName, industry, activeMemberCount: SAMPLE_ACTIVE_MEMBER_COUNT }),
  };
}

function sampleMemberNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Sample Member ${String(i + 1).padStart(2, '0')}`);
}

// Fully synthetic weekly-report sample — used whenever there's no current
// real meeting with attendance to preview instead (a bare/empty database,
// or simply not meeting day). Numbers are the spec's own: 18 members
// present (== activeMemberCount, so "road to 25" reads 18/25 with nobody
// absent), 3 visitors (one with no email on file, to also exercise that
// branch of the template), and a 6-week upward trend.
function syntheticReportData(): LeadershipReportData {
  return {
    meetingDateLabel: 'Sample data — no real meeting yet',
    attendanceCount: 18 + 2 + 3,
    presentMembers: sampleMemberNames(18),
    presentLeadership: ['Sample Leader One', 'Sample Leader Two'],
    absentMembers: [],
    visitors: [
      {
        name: 'Dana Whitfield', industry: 'CPA', email: 'dana@example.com',
        phone: null, company: 'Whitfield & Co', visitNumber: 1,
      },
      {
        name: 'Jordan Rivera', industry: 'Marketing', email: 'jordan@example.com',
        phone: null, company: null, visitNumber: 1,
      },
      {
        name: 'Sam Casey', industry: 'Legal', email: null,
        phone: null, company: null, visitNumber: 2,
      },
    ],
    skippedVisitorEmails: ['Sam Casey'],
    activeMemberCount: SAMPLE_ACTIVE_MEMBER_COUNT,
    membershipGoal: 25,
    weeklyCounts: [17, 19, 18, 21, 20, 23].map((count, i) => ({ meetingDate: `sample-week-${i + 1}`, count })),
    visitorSources: [
      { source: 'Found us online', count: 1 },
      { source: 'Not specified', count: 1 },
      { source: 'Referral', count: 1 },
    ],
    possibleRepeatVisitors: [],
    siteUrl: siteUrl(),
  };
}

// "Current real meeting" = today's meeting (Chicago date), if one exists,
// isn't canceled, and has at least one non-voided check-in — the exact
// same gate app/api/admin/emails' compile action and the cron tick both
// apply before treating a meeting as real/compilable (see that route's own
// CRITICAL comment for why both checks matter).
async function currentMeetingWithAttendance(db: Db, now: Date) {
  const meeting = await findMeetingByDate(db, chicagoDateString(now));
  if (!meeting || meeting.status === 'canceled') return null;
  return (await meetingHasAttendance(db, meeting.id)) ? meeting : null;
}

async function weeklyReportContent(db: Db, now: Date): Promise<TestLabContent> {
  const meeting = await currentMeetingWithAttendance(db, now);
  if (meeting) {
    const { drafts } = await compileForMeeting(db, meeting.id);
    const report = drafts.find((d): d is LeadershipReportDraft => d.type === 'leadership_report')!;
    return { subject: report.subject, html: report.html, text: report.text };
  }
  const data = syntheticReportData();
  return {
    subject: leadershipReportSubject(data.meetingDateLabel),
    html: leadershipReportHtml(data),
    text: leadershipReportText(data),
  };
}

// The public /rsvp/[token] confirmation page (app/rsvp/[token]/page.tsx) has
// no standalone render helper — it's a server component keyed off a live,
// single-use DB token, not something this preview should mint a real one
// for just to render. This replicates its 'rsvp'-purpose ValidView copy for
// a sample first name instead. Preview-only by design (see
// TEST_LAB_SEND_KINDS above) — there's no email to send for a page.
function rsvpPagePreviewHtml(): string {
  const { firstName } = SAMPLE_VISITOR;
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0b0f19;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:420px;margin:0 auto;padding:64px 24px;text-align:center;color:#f5f5f7;">
    <p style="margin:0 0 24px;font-size:13px;letter-spacing:3px;color:#8a8a92;">BNI WHEELING</p>
    <h1 style="margin:0;font-size:28px;font-weight:800;letter-spacing:-0.5px;">You&rsquo;re on the list for Wednesday, ${firstName}</h1>
    <p style="margin:12px 0 0;color:#c7c7cf;">We&rsquo;ll have a seat waiting for you.</p>
    <div style="margin-top:24px;background:rgba(255,255,255,0.05);border-radius:16px;padding:20px;text-align:left;">
      <p style="margin:0;font-weight:700;">BNI Wheeling &middot; weekly meeting</p>
      <p style="margin:4px 0 0;color:#c7c7cf;">${MEETING_LINE}</p>
      <p style="margin:0;color:#c7c7cf;">${VENUE_LINE_1}, ${VENUE_LINE_2}</p>
    </div>
    <p style="margin:24px 0 0;font-size:12px;color:#8a8a92;">Sample preview only &mdash; this is what a visitor sees after tapping the button in their thank-you email.</p>
  </div>
</body>
</html>`;
}

export async function buildTestLabContent(db: Db, kind: TestLabKind, now: Date = new Date()): Promise<TestLabContent> {
  switch (kind) {
    case 'thankyou_v1': return thankyouV1Content();
    case 'thankyou_v2': return thankyouV2Content();
    case 'weekly_report': return weeklyReportContent(db, now);
    case 'rsvp_page': return { subject: 'RSVP page preview', html: rsvpPagePreviewHtml(), text: '' };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown test-lab kind: ${_exhaustive}`);
    }
  }
}
