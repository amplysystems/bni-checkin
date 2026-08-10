// Internal "drafts ready to approve" notification — Phase 2 Task 4's P2-3
// review carry-in. Sent at most once per meeting (see lib/emails/engine.ts's
// ensureApprovalNotice), the first cron tick after that meeting's drafts
// exist AND approve-mode is on. Recipient is always OWNER_EMAIL — this is
// an admin-facing operational email, never member/visitor-facing, so unlike
// the other templates it isn't driven by compile.ts's recipient-set logic.

import { escapeHtml } from './escape-html';

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type ApprovalNoticeInput = {
  meetingDateLabel: string; // e.g. "Wednesday, August 12, 2026"
  siteUrl: string; // e.g. https://bni-checkin-wheeling.netlify.app — no trailing slash
};

export function approvalNoticeSubject(meetingDateLabel: string): string {
  return `Drafts ready to approve — ${meetingDateLabel}`;
}

export function approvalNoticeHtml({ meetingDateLabel, siteUrl }: ApprovalNoticeInput): string {
  const adminUrl = `${siteUrl}/admin`;
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f2f2f5;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;font-family:${FONT};">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e6ea;">
      <div style="background:#0b0f19;padding:20px 28px;">
        <img src="${siteUrl}/bni-logo-transparent.png" alt="BNI" height="34" style="display:inline-block;vertical-align:middle;height:34px;width:auto;" />
        <span style="color:#3a4358;font-size:18px;vertical-align:middle;margin:0 10px;">|</span>
        <span style="color:#f5f2ea;font-size:13px;letter-spacing:3px;font-weight:600;vertical-align:middle;">WHEELING</span>
      </div>
      <div style="padding:28px;">
        <p style="margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#101014;">This week&rsquo;s drafts are ready.</p>
        <div style="width:44px;height:3px;background:#CF2030;margin:0 0 16px;"></div>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3c3c43;">The visitor thank-yous and the leadership report for ${escapeHtml(meetingDateLabel)} are compiled and waiting on your approval &mdash; nothing sends until you approve it.</p>
        <div style="text-align:center;margin:0 0 12px;">
          <a href="${adminUrl}" style="display:block;background:#CF2030;border-radius:10px;padding:14px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Review and approve</a>
        </div>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#8a8a92;">You&rsquo;re getting this because approve-mode is on. This notice only sends once per meeting.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function approvalNoticeText({ meetingDateLabel, siteUrl }: ApprovalNoticeInput): string {
  return [
    `This week's drafts are ready.`,
    ``,
    `The visitor thank-yous and the leadership report for ${meetingDateLabel} are compiled and waiting on your approval — nothing sends until you approve it.`,
    ``,
    `Review and approve: ${siteUrl}/admin`,
  ].join('\n');
}
