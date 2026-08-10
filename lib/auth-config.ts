import type { NextAuthConfig } from 'next-auth';
import Resend from 'next-auth/providers/resend';
import { isAllowed } from '@/lib/allowlist';
import { LOGIN_LINK_SUBJECT, loginLinkHtml, loginLinkText } from '@/emails/login-link';
import { getDb } from '@/lib/db';
import { generateAndStoreOtp } from '@/lib/otp';

// Split out from auth.ts so this config (providers/pages/callbacks/session) can be
// imported directly in tests. auth.ts itself pulls in the top-level `next-auth`
// package (for NextAuth()) which fails to resolve under vitest's node environment
// (next-auth/lib/env.js imports 'next/server', which vitest can't resolve) — so
// tests must not import auth.ts. This module has no such import and is test-safe
// (type-only `next-auth` imports, like the one above, are fine — only a
// top-level VALUE import of the `next-auth` package itself is the problem).
// lib/db and lib/otp ARE safe to import here: tests already transitively use
// lib/db (via other lib modules under test), and importing it doesn't pull in
// 'next-auth' or 'next/server'. This module still does not construct the
// adapter (which needs getDb() bound to next-auth's adapter shape) — auth.ts
// adds that; this file only ever calls getDb() to store OTP rows.

// Canonical origin for links/images inside auth emails. AUTH_URL is the same
// value Auth.js itself uses to build the verification URL, so the two always
// agree; the fallback only matters in local dev.
export function siteUrl(): string {
  return (process.env.AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

export const authConfig = {
  providers: [
    Resend({
      from: process.env.EMAIL_FROM,
      // Branded magic-link email (emails/login-link.ts) instead of the
      // Auth.js default. Plain fetch to Resend's API — the provider's
      // apiKey is wired from AUTH_RESEND_KEY by Auth.js env defaults.
      async sendVerificationRequest({ identifier, url, provider }) {
        // Reached only for an already-allowlisted address: @auth/core's
        // sendToken (lib/actions/signin/send-token.ts) runs
        // callbacks.signIn — which throws AccessDenied for anyone
        // isAllowed() rejects — BEFORE it ever calls
        // provider.sendVerificationRequest. Verified directly in the
        // installed @auth/core source, not assumed. No separate isAllowed
        // check is needed (or possible — this callback isn't given the
        // allowlist result), but lib/otp.ts's verifyOtpAndCreateSession
        // re-checks it anyway on the verify side, independent of this.
        //
        // Six-digit code: generated fresh on every send (one active code
        // per address — generateAndStoreOtp deletes any prior otp:{email}
        // row first) so the emailed link and the emailed code always agree
        // on "this is the current, only-valid credential." Lets an admin
        // on the INSTALLED PWA (separate cookie jar, can't follow the link
        // back into the app) type the code into the app instead.
        const secret = process.env.AUTH_SECRET;
        if (!secret) throw new Error('AUTH_SECRET is required to generate a sign-in code');
        const code = await generateAndStoreOtp(getDb(), identifier, secret);

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${provider.apiKey ?? process.env.AUTH_RESEND_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: provider.from ?? 'onboarding@resend.dev',
            to: identifier,
            subject: LOGIN_LINK_SUBJECT,
            html: loginLinkHtml({ url, siteUrl: siteUrl(), code }),
            text: loginLinkText({ url, code }),
          }),
        });
        if (!res.ok) {
          throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
        }
      },
    }),
  ],
  pages: { signIn: '/admin/login' },
  session: { maxAge: 7 * 24 * 60 * 60 },
  callbacks: {
    signIn({ user }) {
      return isAllowed(user?.email, process.env.ADMIN_ALLOWLIST);
    },
  },
} satisfies NextAuthConfig;
