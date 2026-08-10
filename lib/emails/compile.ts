// Compiles the two email "groups" for one meeting from live data: the
// leadership report (one draft) and a visitor thank-you per present
// visitor who has an email on file (N drafts, v1 or v2 template chosen by
// visitNumber). Pure read + string-building — no writes. lib/emails/
// engine.ts's createDrafts() is what actually persists these as
// email_messages rows; compile.ts is also the thing Task 5's admin Preview
// calls directly for "always shows the current compilation" (spec §6).

import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { attendance, meetings, memberships, people, settings as settingsTable } from '@/db/schema';
import type { Db } from '@/lib/db';
import { OWNER_EMAIL, siteUrl } from './constants';
import { leadershipReportSendKey, visitorThankyouSendKey } from './send-keys';
import { visitorThankyouSubject, visitorThankyouHtml, visitorThankyouText } from '@/emails/visitor-thankyou';
import { visitorConversionSubject, visitorConversionHtml, visitorConversionText } from '@/emails/visitor-conversion';
import {
  leadershipReportSubject, leadershipReportHtml, leadershipReportText,
  type LeadershipReportData, type WeeklyCount,
} from '@/emails/leadership-report';

const MEMBERSHIP_GOAL = 25;
const WEEKLY_HISTORY_COUNT = 6;

export class CompileError extends Error {
  constructor(public code: 'meeting_not_found') { super(code); }
}

export type VisitorThankyouDraft = {
  type: 'visitor_thankyou';
  sendKey: string;
  personId: string;
  isConversion: boolean; // true -> v2 (emails/visitor-conversion.ts); false -> v1
  recipients: string[];
  subject: string;
  html: string;
  text: string;
};

export type LeadershipReportDraft = {
  type: 'leadership_report';
  sendKey: string;
  recipients: string[];
  subject: string;
  html: string;
  text: string;
};

export type CompiledDraft = VisitorThankyouDraft | LeadershipReportDraft;

export type CompiledMeeting = {
  meeting: typeof meetings.$inferSelect;
  drafts: CompiledDraft[];
};

function displayName(p: { fullName: string; displayName: string | null }): string {
  return p.displayName ?? p.fullName;
}

function firstNameOf(full: string): string {
  return full.trim().split(/\s+/)[0] || full;
}

function formatMeetingDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(dt);
}

// Up to the last WEEKLY_HISTORY_COUNT meetings on or before this one
// (inclusive of this one — "last 6 weeks" reads naturally as ending with
// today), returned oldest -> newest.
async function compileWeeklyCounts(db: Db, uptoDateStr: string): Promise<WeeklyCount[]> {
  const recentMeetings = await db.select().from(meetings)
    .where(lte(meetings.meetingDate, uptoDateStr))
    .orderBy(desc(meetings.meetingDate))
    .limit(WEEKLY_HISTORY_COUNT);
  if (recentMeetings.length === 0) return [];

  const ids = recentMeetings.map((m) => m.id);
  const attRows = await db.select({ meetingId: attendance.meetingId }).from(attendance)
    .where(and(inArray(attendance.meetingId, ids), isNull(attendance.voidedAt)));
  const counts = new Map<string, number>();
  for (const r of attRows) counts.set(r.meetingId, (counts.get(r.meetingId) ?? 0) + 1);

  return recentMeetings.slice().reverse()
    .map((m) => ({ meetingDate: m.meetingDate, count: counts.get(m.id) ?? 0 }));
}

export async function compileForMeeting(db: Db, meetingId: string): Promise<CompiledMeeting> {
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!meeting) throw new CompileError('meeting_not_found');

  const [settingsRow] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1));
  const reportRecipients = settingsRow?.reportRecipients ?? [];

  const rows = await db.select({
    personId: attendance.personId,
    kind: attendance.kind,
    visitNumber: attendance.visitNumber,
    fullName: people.fullName,
    displayName: people.displayName,
    industry: people.industry,
    company: people.company,
    email: people.email,
    phone: people.phone,
  }).from(attendance)
    .innerJoin(people, eq(people.id, attendance.personId))
    .where(and(eq(attendance.meetingId, meetingId), isNull(attendance.voidedAt)));

  const presentMembers = rows.filter((r) => r.kind === 'member')
    .map(displayName).sort((a, b) => a.localeCompare(b));
  const presentLeadership = rows.filter((r) => r.kind === 'leadership')
    .map(displayName).sort((a, b) => a.localeCompare(b));
  const visitorRows = rows.filter((r) => r.kind === 'visitor');

  // Active member roster, same shape/filters as lib/checkins.ts's
  // kioskRoster member query — needed here only to compute who's absent.
  const activeMemberRows = await db.select({
    id: people.id, fullName: people.fullName, displayName: people.displayName,
  }).from(people)
    .innerJoin(memberships, and(
      eq(memberships.personId, people.id),
      eq(memberships.status, 'member'),
      isNull(memberships.endedAt),
    ))
    .where(isNull(people.deactivatedAt));

  const presentMemberIds = new Set(rows.filter((r) => r.kind === 'member').map((r) => r.personId));
  const absentMembers = activeMemberRows
    .filter((m) => !presentMemberIds.has(m.id))
    .map(displayName).sort((a, b) => a.localeCompare(b));

  const weeklyCounts = await compileWeeklyCounts(db, meeting.meetingDate);
  const url = siteUrl();
  const meetingDateLabel = formatMeetingDateLabel(meeting.meetingDate);

  const skippedVisitorEmails: string[] = [];
  const visitorDrafts: VisitorThankyouDraft[] = [];
  const reportVisitors: LeadershipReportData['visitors'] = [];

  for (const v of visitorRows) {
    const name = displayName(v);
    reportVisitors.push({
      name, industry: v.industry, email: v.email, phone: v.phone,
      company: v.company, visitNumber: v.visitNumber,
    });

    if (!v.email) {
      skippedVisitorEmails.push(name);
      continue;
    }

    const isConversion = (v.visitNumber ?? 1) >= 2;
    const firstName = firstNameOf(name);
    if (isConversion) {
      visitorDrafts.push({
        type: 'visitor_thankyou',
        sendKey: visitorThankyouSendKey(meetingId, v.personId),
        personId: v.personId,
        isConversion: true,
        recipients: [v.email],
        subject: visitorConversionSubject(firstName),
        html: visitorConversionHtml({ firstName, industry: v.industry, siteUrl: url }),
        text: visitorConversionText({ firstName, industry: v.industry }),
      });
    } else {
      visitorDrafts.push({
        type: 'visitor_thankyou',
        sendKey: visitorThankyouSendKey(meetingId, v.personId),
        personId: v.personId,
        isConversion: false,
        recipients: [v.email],
        subject: visitorThankyouSubject(firstName),
        html: visitorThankyouHtml({ firstName, siteUrl: url }),
        text: visitorThankyouText({ firstName }),
      });
    }
  }

  const activeMemberCount = activeMemberRows.length;
  const reportData: LeadershipReportData = {
    meetingDateLabel,
    attendanceCount: rows.length,
    presentMembers,
    presentLeadership,
    absentMembers,
    visitors: reportVisitors,
    skippedVisitorEmails,
    activeMemberCount,
    membershipGoal: MEMBERSHIP_GOAL,
    weeklyCounts,
    siteUrl: url,
  };

  // recipients = settings.reportRecipients ∪ owner (Jason always gets it,
  // even if someone clears the settings list; Set dedupes a redundant
  // explicit entry).
  const reportRecipientsSet = Array.from(new Set([...reportRecipients, OWNER_EMAIL]));
  const reportDraft: LeadershipReportDraft = {
    type: 'leadership_report',
    sendKey: leadershipReportSendKey(meetingId),
    recipients: reportRecipientsSet,
    subject: leadershipReportSubject(meetingDateLabel),
    html: leadershipReportHtml(reportData),
    text: leadershipReportText(reportData),
  };

  return { meeting, drafts: [reportDraft, ...visitorDrafts] };
}
