// Visitor conversion email (v2) — sent instead of emails/visitor-thankyou.ts
// when a visitor is on their SECOND (or later) recorded visit (visitNumber
// >= 2, decided in lib/emails/compile.ts). Same design system as the v1
// template: navy header + transparent BNI logo via siteUrl, red accent bar,
// Amply footer; same email-client constraints (inline styles, system font
// stack, absolute image URLs — see visitor-thankyou.ts's header comment).
//
// COPY STATUS: PLACEHOLDER. The structure below (acknowledgment headline ->
// open-seat scarcity for their industry -> one social-proof line -> meeting
// details -> CTA -> reply line -> signature) is final; the actual WORDING
// is a first draft only and is NOT approved. Every user-facing string is
// wrapped in a `/* COPY PENDING JASON'S APPROVAL */` marker. The controller
// is running a dedicated copy/design review with Jason before this
// template ships to a real visitor (Phase 2 plan, Task 3 note) — until
// then this only ever reaches Jason's own inbox (SAFE_MODE).

import { MEETING_LINE, VENUE_LINE_1, VENUE_LINE_2 } from './visitor-thankyou';

export type VisitorConversionInput = {
  firstName: string;
  industry: string | null;
  siteUrl: string; // e.g. https://bni-checkin-wheeling.netlify.app — no trailing slash
  rsvpUrl?: string; // Task 6 wires a real per-visitor RSVP token; '#' until then
};

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DEFAULT_RSVP_URL = '#';

function industryPhrase(industry: string | null): string {
  return industry && industry.trim() ? industry.trim() : 'your industry';
}

export function visitorConversionSubject(firstName: string): string {
  /* COPY PENDING JASON'S APPROVAL */
  return `Twice now, ${firstName} — let's talk`;
}

export function visitorConversionHtml(
  { firstName, industry, siteUrl, rsvpUrl = DEFAULT_RSVP_URL }: VisitorConversionInput,
): string {
  const seat = industryPhrase(industry);
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
        <!-- COPY PENDING JASON'S APPROVAL: "twice now" acknowledgment headline -->
        <p style="margin:0 0 6px;font-size:23px;font-weight:800;letter-spacing:-0.5px;color:#101014;">Twice now. That&rsquo;s not an accident.</p>
        <div style="width:44px;height:3px;background:#CF2030;margin:0 0 16px;"></div>
        <!-- COPY PENDING JASON'S APPROVAL: acknowledgment + open-seat scarcity line -->
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#3c3c43;">${firstName} &mdash; you&rsquo;ve now visited BNI Wheeling twice, and that tells us something. The ${seat} seat is still open, and we&rsquo;d rather it go to someone who already knows the room.</p>
        <!-- COPY PENDING JASON'S APPROVAL: one social-proof line -->
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3c3c43;">Our members pass real business to each other every week &mdash; ask anyone in the room and they&rsquo;ll tell you the same thing.</p>
        <div style="background:#f7f7f9;border-radius:10px;padding:14px 18px;margin:0 0 20px;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#101014;">BNI Wheeling &middot; weekly meeting</p>
          <p style="margin:2px 0 0;font-size:14px;color:#55555e;">${MEETING_LINE}</p>
          <p style="margin:2px 0 0;font-size:14px;color:#55555e;">${VENUE_LINE_1}, ${VENUE_LINE_2}</p>
        </div>
        <div style="text-align:center;margin:0 0 18px;">
          <!-- COPY PENDING JASON'S APPROVAL: CTA label -->
          <a href="${rsvpUrl}" style="display:block;background:#CF2030;border-radius:10px;padding:14px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Let&rsquo;s talk about the ${seat} seat</a>
        </div>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#55555e;">Or just hit reply &mdash; this email comes straight to me.</p>
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
  { firstName, industry }: { firstName: string; industry: string | null },
): string {
  const seat = industryPhrase(industry);
  /* COPY PENDING JASON'S APPROVAL */
  return [
    `Twice now. That's not an accident.`,
    ``,
    `${firstName} — you've now visited BNI Wheeling twice, and that tells us something. The ${seat} seat is still open, and we'd rather it go to someone who already knows the room.`,
    ``,
    `Our members pass real business to each other every week — ask anyone in the room and they'll tell you the same thing.`,
    ``,
    `BNI Wheeling · weekly meeting`,
    MEETING_LINE,
    `${VENUE_LINE_1}, ${VENUE_LINE_2}`,
    ``,
    `Just hit reply — this email comes straight to me.`,
    ``,
    `Jason Barrios`,
    `BNI Wheeling`,
  ].join('\n');
}
