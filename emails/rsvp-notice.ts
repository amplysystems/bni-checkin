// Internal RSVP/interest notification — Phase 2 Task 6. Fired at most once
// per token, the first time its /rsvp/[token] link is opened (see
// lib/rsvp-visit.ts and lib/emails/engine.ts's ensureRsvpNotice). Recipient
// is always OWNER_EMAIL, same admin-facing convention as
// emails/approval-notice.ts — this is never member/visitor-facing.

import { escapeHtml } from './escape-html';

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type RsvpNoticePurpose = 'rsvp' | 'interest';

export type RsvpNoticeInput = {
  purpose: RsvpNoticePurpose;
  personFullName: string;
  siteUrl: string; // e.g. https://bni-checkin-wheeling.netlify.app — no trailing slash
};

// Exact wording per the plan's VISION-DOC ADOPTIONS paragraph.
export function rsvpNoticeSubject(purpose: RsvpNoticePurpose, personFullName: string): string {
  return purpose === 'rsvp'
    ? `${personFullName} plans to visit Wednesday`
    : `${personFullName} is interested in membership`;
}

function headline(purpose: RsvpNoticePurpose): string {
  return purpose === 'rsvp' ? 'A visitor RSVP’d.' : 'Someone’s interested in membership.';
}

export function rsvpNoticeHtml({ purpose, personFullName, siteUrl }: RsvpNoticeInput): string {
  const adminUrl = `${siteUrl}/admin`;
  const body = escapeHtml(rsvpNoticeSubject(purpose, personFullName));
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
        <p style="margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#101014;">${headline(purpose)}</p>
        <div style="width:44px;height:3px;background:#CF2030;margin:0 0 16px;"></div>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3c3c43;">${body}</p>
        <div style="text-align:center;margin:0 0 12px;">
          <a href="${adminUrl}" style="display:block;background:#CF2030;border-radius:10px;padding:14px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Open the admin</a>
        </div>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#8a8a92;">You&rsquo;re getting this because their link was just opened for the first time. This notice only sends once per link.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function rsvpNoticeText({ purpose, personFullName, siteUrl }: RsvpNoticeInput): string {
  return [
    headline(purpose),
    '',
    rsvpNoticeSubject(purpose, personFullName),
    '',
    `Open the admin: ${siteUrl}/admin`,
  ].join('\n');
}
