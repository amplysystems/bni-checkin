// Branded magic-link (admin sign-in) email — same design language as
// emails/visitor-thankyou.ts: navy header with the transparent BNI logo,
// red CTA, Amply footer. Same email-client constraints (inline styles,
// system font stack, absolute image URLs).

export type LoginLinkInput = {
  url: string; // the Auth.js verification URL — must be used EXACTLY as given
  siteUrl: string; // canonical origin for image URLs, no trailing slash
  // Six-digit sign-in code (lib/otp.ts's generateAndStoreOtp), generated
  // fresh for every send and rides along with the link so an admin on the
  // INSTALLED iOS/desktop PWA — which has its own cookie jar and can't
  // follow the emailed link back into itself — can type this into the app
  // instead. Always present: sendVerificationRequest (lib/auth-config.ts)
  // generates one on every send, link or not.
  code: string;
};

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO_FONT = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

export const LOGIN_LINK_SUBJECT = 'Your BNI Wheeling sign-in link';

export function loginLinkHtml({ url, siteUrl, code }: LoginLinkInput): string {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f2f2f5;">
  <div style="max-width:520px;margin:0 auto;padding:24px 12px;font-family:${FONT};">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e6e6ea;">
      <div style="background:#0b0f19;padding:20px 28px;">
        <img src="${siteUrl}/bni-logo-transparent.png" alt="BNI" height="34" style="display:inline-block;vertical-align:middle;height:34px;width:auto;" />
        <span style="color:#3a4358;font-size:18px;vertical-align:middle;margin:0 10px;">|</span>
        <span style="color:#f5f2ea;font-size:13px;letter-spacing:3px;font-weight:600;vertical-align:middle;">WHEELING</span>
      </div>
      <div style="padding:28px;">
        <p style="margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#101014;">Sign in to your admin</p>
        <div style="width:44px;height:3px;background:#CF2030;margin:0 0 16px;"></div>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3c3c43;">Tap the button below and you&rsquo;re in. This link works once and expires in 24 hours.</p>
        <div style="text-align:center;margin:0 0 20px;">
          <a href="${url}" style="display:block;background:#CF2030;border-radius:10px;padding:14px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Sign in to BNI Wheeling</a>
        </div>
        <div style="margin:0 0 20px;padding-top:20px;border-top:1px solid #ececf0;">
          <p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:#8a8a92;">Using the installed app? Enter this code instead:</p>
          <p style="margin:0;font-family:${MONO_FONT};font-size:32px;font-weight:700;letter-spacing:10px;color:#101014;text-align:center;">${code}</p>
          <p style="margin:8px 0 0;font-size:12px;color:#a0a0a8;text-align:center;">Expires in 15 minutes.</p>
        </div>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#8a8a92;">Didn&rsquo;t request this? You can safely ignore it &mdash; nobody can sign in without this email.</p>
      </div>
      <div style="border-top:1px solid #ececf0;padding:14px 28px;">
        <p style="margin:0;font-size:11px;color:#a0a0a8;">BNI Wheeling admin &nbsp;&middot;&nbsp; Powered by Amply Systems</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function loginLinkText({ url, code }: { url: string; code: string }): string {
  return [
    'Sign in to your BNI Wheeling admin:',
    '',
    url,
    '',
    'This link works once and expires in 24 hours.',
    '',
    `Using the installed app? Enter this code instead: ${code}`,
    'This code expires in 15 minutes.',
    '',
    "Didn't request this? You can safely ignore it.",
  ].join('\n');
}
