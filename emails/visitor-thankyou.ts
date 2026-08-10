// Visitor thank-you email — design approved by Jason 2026-08-09.
// Email-client constraints: table-free simple divs work in Gmail/Apple Mail/
// Outlook.com; all styles inline; system font stack (webfonts don't survive
// most inboxes); images referenced by absolute URL from the deployed site.
// Sent by the Phase 2 engine at ~5:30 PM CT on meeting days; reply-to is a
// human inbox by design.

export type VisitorThankyouInput = {
  firstName: string;
  siteUrl: string; // e.g. https://bni-checkin-wheeling.netlify.app — no trailing slash
};

export const VENUE_LINE_1 = 'Devon Bank';
export const VENUE_LINE_2 = '561 N Milwaukee Ave, Wheeling, IL 60090';
export const MEETING_LINE = 'Wednesdays · 3:30 PM';

export function visitorThankyouSubject(firstName: string): string {
  return `Great meeting you today, ${firstName}`;
}

export function visitorThankyouHtml({ firstName, siteUrl }: VisitorThankyouInput): string {
  const font =
    "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f2f2f5;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;font-family:${font};">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e6ea;">
      <div style="background:#0b0f19;padding:20px 28px;">
        <img src="${siteUrl}/bni-logo-transparent.png" alt="BNI" height="34" style="display:inline-block;vertical-align:middle;height:34px;width:auto;" />
        <span style="color:#3a4358;font-size:18px;vertical-align:middle;margin:0 10px;">|</span>
        <span style="color:#f5f2ea;font-size:13px;letter-spacing:3px;font-weight:600;vertical-align:middle;">WHEELING</span>
      </div>
      <div style="padding:28px;">
        <p style="margin:0 0 6px;font-size:23px;font-weight:800;letter-spacing:-0.5px;color:#101014;">It was great meeting you today.</p>
        <div style="width:44px;height:3px;background:#CF2030;margin:0 0 16px;"></div>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#3c3c43;">${firstName} &mdash; thanks for visiting BNI Wheeling. The room is better when new faces show up, and yours was a good one to have across the table.</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3c3c43;">We meet every week, and we&rsquo;d love to see you again &mdash; as our guest, no strings.</p>
        <div style="background:#f7f7f9;border-radius:10px;padding:14px 18px;margin:0 0 20px;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#101014;">BNI Wheeling &middot; weekly meeting</p>
          <p style="margin:2px 0 0;font-size:14px;color:#55555e;">${MEETING_LINE}</p>
          <p style="margin:2px 0 0;font-size:14px;color:#55555e;">${VENUE_LINE_1}, ${VENUE_LINE_2}</p>
        </div>
        <div style="text-align:center;margin:0 0 18px;">
          <a href="mailto:?subject=Save%20my%20seat%20for%20Wednesday" style="display:block;background:#CF2030;border-radius:10px;padding:14px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Save my seat for next Wednesday</a>
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

export function visitorThankyouText({ firstName }: { firstName: string }): string {
  return [
    `It was great meeting you today.`,
    ``,
    `${firstName} — thanks for visiting BNI Wheeling. The room is better when new faces show up, and yours was a good one to have across the table.`,
    ``,
    `We meet every week, and we'd love to see you again — as our guest, no strings.`,
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
