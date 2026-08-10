// Shared constants across the email engine (compile.ts / engine.ts /
// send.ts) — kept in one small module so OWNER_EMAIL (the SAFE_MODE
// redirect target AND the "always Jason" leadership-report recipient) and
// siteUrl() (absolute origin for template image URLs, same pattern as
// lib/auth-config.ts's private siteUrl()) each have exactly one definition.

// Jason's own inbox — the Resend account owner. Every send is redirected
// here while SAFE_MODE is on (lib/emails/send.ts), and the leadership
// report always includes it regardless of settings.reportRecipients
// (lib/emails/compile.ts). Overridable via env for local/test flexibility,
// but the literal fallback matches the account this whole app was built
// against.
export const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'barriosj4@gmail.com';

export function siteUrl(): string {
  return (process.env.AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}
