// Weekly leadership report — branded like the other Phase 2 emails (navy
// header + transparent BNI logo, red accent bar, Amply footer) but this
// template takes a fully compiled, typed data object and touches no
// database itself: lib/emails/compile.ts is responsible for gathering
// everything below from live data. Sent to settings.reportRecipients ∪
// Jason at settings.reportSendTime (~5:30 PM CT on meeting Wednesdays).
// Same email-client constraints as the other templates (inline styles,
// system font stack, absolute image URLs).

import { escapeHtml } from './escape-html';

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type LeadershipReportVisitor = {
  name: string;
  industry: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  visitNumber: number | null;
};

export type WeeklyCount = { meetingDate: string; count: number };

export type LeadershipReportData = {
  meetingDateLabel: string; // pre-formatted, e.g. "Wednesday, August 12, 2026"
  attendanceCount: number; // all non-voided attendees (members+leadership+visitors)
  presentMembers: string[]; // display names, pre-sorted
  presentLeadership: string[];
  absentMembers: string[]; // active members who did not check in
  visitors: LeadershipReportVisitor[];
  skippedVisitorEmails: string[]; // present visitors with no email on file — named so nobody's silently missed
  activeMemberCount: number;
  membershipGoal: number; // 25
  weeklyCounts: WeeklyCount[]; // up to the last 6 meetings, chronological oldest -> newest
  siteUrl: string;
};

export function leadershipReportSubject(meetingDateLabel: string): string {
  return `BNI Wheeling — weekly report, ${meetingDateLabel}`;
}

function roadToGoalBar(activeMemberCount: number, membershipGoal: number): string {
  const pct = membershipGoal > 0 ? Math.min(100, Math.round((activeMemberCount / membershipGoal) * 100)) : 0;
  return `
        <div style="margin:0 0 20px;">
          <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#101014;">Road to 25 &middot; ${activeMemberCount} / ${membershipGoal} active members</p>
          <div style="background:#ececf0;border-radius:999px;height:10px;overflow:hidden;">
            <div style="background:#CF2030;height:10px;width:${pct}%;border-radius:999px;"></div>
          </div>
        </div>`;
}

// `names` are always person-supplied (roster/attendance display names).
function nameList(names: string[], emptyLabel: string): string {
  if (names.length === 0) return `<p style="margin:0;font-size:14px;color:#8a8a92;">${emptyLabel}</p>`;
  return `<p style="margin:0;font-size:14px;line-height:1.7;color:#3c3c43;">${names.map(escapeHtml).join(', ')}</p>`;
}

function visitorRow(v: LeadershipReportVisitor): string {
  const badge = v.visitNumber !== null && v.visitNumber >= 2
    ? `<span style="display:inline-block;margin-left:8px;background:#fdecee;color:#CF2030;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">Visit #${v.visitNumber} &middot; talk membership</span>`
    : '';
  const email = v.email !== null ? escapeHtml(v.email) : 'no email on file';
  const phone = v.phone ? escapeHtml(v.phone) : null;
  const contact = [email, phone].filter(Boolean).join(' &middot; ');
  const industry = v.industry !== null ? escapeHtml(v.industry) : 'Industry not on file';
  const company = v.company ? ` &middot; ${escapeHtml(v.company)}` : '';
  return `
        <div style="padding:10px 0;border-bottom:1px solid #ececf0;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#101014;">${escapeHtml(v.name)}${badge}</p>
          <p style="margin:2px 0 0;font-size:13px;color:#55555e;">${industry}${company}</p>
          <p style="margin:2px 0 0;font-size:13px;color:#8a8a92;">${contact}</p>
        </div>`;
}

function weeklyCountsLine(weeklyCounts: WeeklyCount[]): string {
  if (weeklyCounts.length === 0) return 'No meeting history yet.';
  return weeklyCounts.map((w) => w.count).join(' · ');
}

export function leadershipReportHtml(data: LeadershipReportData): string {
  const visitorsHtml = data.visitors.length > 0
    ? data.visitors.map(visitorRow).join('')
    : '<p style="margin:0;font-size:14px;color:#8a8a92;">No visitors this week.</p>';

  const skippedHtml = data.skippedVisitorEmails.length > 0
    ? `<p style="margin:12px 0 0;font-size:12px;color:#8a8a92;">No email on file (not sent a thank-you): ${data.skippedVisitorEmails.map(escapeHtml).join(', ')}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f2f2f5;">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px;font-family:${FONT};">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e6ea;">
      <div style="background:#0b0f19;padding:20px 28px;">
        <img src="${data.siteUrl}/bni-logo-transparent.png" alt="BNI" height="34" style="display:inline-block;vertical-align:middle;height:34px;width:auto;" />
        <span style="color:#3a4358;font-size:18px;vertical-align:middle;margin:0 10px;">|</span>
        <span style="color:#f5f2ea;font-size:13px;letter-spacing:3px;font-weight:600;vertical-align:middle;">WHEELING</span>
      </div>
      <div style="padding:28px;">
        <p style="margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#101014;">Weekly report &middot; ${data.meetingDateLabel}</p>
        <div style="width:44px;height:3px;background:#CF2030;margin:0 0 20px;"></div>

        ${roadToGoalBar(data.activeMemberCount, data.membershipGoal)}

        <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#101014;">Attendance &middot; ${data.attendanceCount} checked in</p>
        <p style="margin:0 0 4px;font-size:12px;color:#8a8a92;">Members present</p>
        ${nameList(data.presentMembers, 'No members checked in.')}
        <p style="margin:12px 0 4px;font-size:12px;color:#8a8a92;">Leadership present</p>
        ${nameList(data.presentLeadership, 'None checked in.')}
        <p style="margin:12px 0 4px;font-size:12px;color:#8a8a92;">Absent members</p>
        ${nameList(data.absentMembers, 'Everyone showed up.')}

        <p style="margin:24px 0 6px;font-size:14px;font-weight:700;color:#101014;">Visitors (${data.visitors.length})</p>
        ${visitorsHtml}
        ${skippedHtml}

        <p style="margin:24px 0 6px;font-size:14px;font-weight:700;color:#101014;">Last 6 weeks</p>
        <p style="margin:0;font-size:14px;color:#3c3c43;">${weeklyCountsLine(data.weeklyCounts)}</p>
      </div>
      <div style="border-top:1px solid #ececf0;padding:14px 28px;">
        <p style="margin:0;font-size:11px;color:#a0a0a8;">BNI Wheeling weekly report &nbsp;&middot;&nbsp; Powered by Amply Systems</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function leadershipReportText(data: LeadershipReportData): string {
  const lines = [
    `Weekly report · ${data.meetingDateLabel}`,
    '',
    `Road to 25: ${data.activeMemberCount} / ${data.membershipGoal} active members`,
    '',
    `Attendance: ${data.attendanceCount} checked in`,
    `Members present: ${data.presentMembers.join(', ') || 'none'}`,
    `Leadership present: ${data.presentLeadership.join(', ') || 'none'}`,
    `Absent members: ${data.absentMembers.join(', ') || 'none'}`,
    '',
    `Visitors (${data.visitors.length}):`,
    ...(data.visitors.length > 0
      ? data.visitors.map((v) => {
        const tag = v.visitNumber !== null && v.visitNumber >= 2 ? ` [visit #${v.visitNumber} — talk membership]` : '';
        return `  - ${v.name}${tag} — ${v.industry ?? 'industry n/a'}${v.company ? `, ${v.company}` : ''} — ${v.email ?? 'no email'}${v.phone ? `, ${v.phone}` : ''}`;
      })
      : ['  (none this week)']),
    ...(data.skippedVisitorEmails.length > 0
      ? [`  No email on file (not sent a thank-you): ${data.skippedVisitorEmails.join(', ')}`]
      : []),
    '',
    `Last 6 weeks: ${weeklyCountsLine(data.weeklyCounts)}`,
  ];
  return lines.join('\n');
}
