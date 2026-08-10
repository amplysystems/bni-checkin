// Visitor conversion email (v2) — sent instead of emails/visitor-thankyou.ts
// when a visitor is on their SECOND (or later) recorded visit (visitNumber
// >= 2, decided in lib/emails/compile.ts). Same design system as the v1
// template: navy header + transparent BNI logo via siteUrl, red accent bar,
// Amply footer; same email-client constraints (inline styles, system font
// stack, absolute image URLs — see visitor-thankyou.ts's header comment).
//
// COPY STATUS: APPROVED by Jason, 2026-08-10 — verbatim per the controller.
// activeMemberCount (the road-to-25 figure) is threaded in from
// lib/emails/compile.ts, which already computes it for the leadership
// report, rather than this template re-deriving it.
//
// CTA (Task 6 VISION-DOC ADOPTION (1), APPROVED by Jason 2026-08-10):
// "I'm interested in membership" — interest capture, not an RSVP, because a
// visitor after visit 2 has no visit 3 to RSVP for. The button's 'interest'
// token records the response and notifies Jason (lib/emails/compile.ts,
// lib/rsvp-visit.ts).

import { MEETING_LINE, VENUE_LINE_1, VENUE_LINE_2 } from './visitor-thankyou';
import { escapeHtml } from './escape-html';

export type VisitorConversionInput = {
  firstName: string;
  industry: string | null;
  activeMemberCount: number;
  siteUrl: string; // e.g. https://bni-checkin-wheeling.netlify.app — no trailing slash
  rsvpUrl?: string; // Task 6: a real per-visitor 'interest' token, wired in lib/emails/compile.ts
};

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DEFAULT_RSVP_URL = '#';

// Used verbatim as stored on the person record — no case transformation.
function industryOrNull(industry: string | null): string | null {
  return industry && industry.trim() ? industry.trim() : null;
}

export function visitorConversionSubject(firstName: string, industry: string | null): string {
  const seat = industryOrNull(industry);
  return seat ? `The ${seat} seat is still open, ${firstName}` : `A seat is still open for you, ${firstName}`;
}

// `escape` defaults to identity for the plain-text template; the HTML
// template passes escapeHtml so only the person-supplied industry
// substitution gets escaped, not the surrounding static wording.
function seatSentence(industry: string | null, escape: (s: string) => string = (s) => s): string {
  const seat = industryOrNull(industry);
  return seat ? `The ${escape(seat)} seat at Wheeling is still open` : 'Your seat at Wheeling is still open';
}

export function visitorConversionHtml(
  { firstName, industry, activeMemberCount, siteUrl, rsvpUrl = DEFAULT_RSVP_URL }: VisitorConversionInput,
): string {
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
        <p style="margin:0 0 6px;font-size:23px;font-weight:800;letter-spacing:-0.5px;color:#101014;">Twice now.</p>
        <div style="width:44px;height:3px;background:#CF2030;margin:0 0 16px;"></div>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3c3c43;">${escapeHtml(firstName)} &mdash; you&rsquo;ve seen the room twice, and the room noticed. So here&rsquo;s the part of BNI that matters most:</p>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.6;font-weight:600;color:#101014;">One seat per industry. ${seatSentence(industry, escapeHtml)} &mdash; and once it&rsquo;s filled, every referral in this room goes to whoever holds it.</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3c3c43;">${activeMemberCount} founding members have already claimed theirs. They&rsquo;re across the table every Wednesday, passing business to each other on purpose.</p>
        <div style="background:#f7f7f9;border-radius:10px;padding:14px 18px;margin:0 0 20px;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#101014;">BNI Wheeling &middot; weekly meeting</p>
          <p style="margin:2px 0 0;font-size:14px;color:#55555e;">${MEETING_LINE}</p>
          <p style="margin:2px 0 0;font-size:14px;color:#55555e;">${VENUE_LINE_1}, ${VENUE_LINE_2}</p>
        </div>
        <div style="text-align:center;margin:0 0 18px;">
          <a href="${rsvpUrl}" style="display:block;background:#CF2030;border-radius:10px;padding:14px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">I&rsquo;m interested in membership</a>
        </div>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#55555e;">Questions about membership? Just reply &mdash; this email comes straight to me, and I&rsquo;ll give you the straight answer.</p>
        <p style="margin:16px 0 0;font-size:14px;color:#101014;font-weight:600;">Jason Barrios</p>
        <p style="margin:0;font-size:13px;color:#8a8a92;">BNI Wheeling</p>
      </div>
      <div style="border-top:1px solid #ececf0;padding:14px 28px;">
        <p style="margin:0;font-size:11px;color:#a0a0a8;">You&rsquo;re receiving this because you visited BNI Wheeling. &nbsp;&middot;&nbsp; Powered by Amply Systems</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function visitorConversionText(
  { firstName, industry, activeMemberCount }: { firstName: string; industry: string | null; activeMemberCount: number },
): string {
  return [
    `Twice now.`,
    ``,
    `${firstName} — you've seen the room twice, and the room noticed. So here's the part of BNI that matters most:`,
    ``,
    `One seat per industry. ${seatSentence(industry)} — and once it's filled, every referral in this room goes to whoever holds it.`,
    ``,
    `${activeMemberCount} founding members have already claimed theirs. They're across the table every Wednesday, passing business to each other on purpose.`,
    ``,
    `BNI Wheeling · weekly meeting`,
    MEETING_LINE,
    `${VENUE_LINE_1}, ${VENUE_LINE_2}`,
    ``,
    `Questions about membership? Just reply — this email comes straight to me, and I'll give you the straight answer.`,
    ``,
    `Jason Barrios`,
    `BNI Wheeling`,
  ].join('\n');
}
