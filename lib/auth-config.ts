import type { NextAuthConfig } from 'next-auth';
import Resend from 'next-auth/providers/resend';
import { isAllowed } from '@/lib/allowlist';
import { LOGIN_LINK_SUBJECT, loginLinkHtml, loginLinkText } from '@/emails/login-link';

// Split out from auth.ts so this config (providers/pages/callbacks/session) can be
// imported directly in tests. auth.ts itself pulls in the top-level `next-auth`
// package (for NextAuth()) which fails to resolve under vitest's node environment
// (next-auth/lib/env.js imports 'next/server', which vitest can't resolve) — so
// tests must not import auth.ts. This module has no such import and is test-safe.
// It also does not construct the adapter (which needs getDb()) — auth.ts adds that.

// Canonical origin for links/images inside auth emails. AUTH_URL is the same
// value Auth.js itself uses to build the verification URL, so the two always
// agree; the fallback only matters in local dev.
function siteUrl(): string {
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
            html: loginLinkHtml({ url, siteUrl: siteUrl() }),
            text: loginLinkText({ url }),
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
