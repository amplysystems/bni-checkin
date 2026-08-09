import type { NextAuthConfig } from 'next-auth';
import Resend from 'next-auth/providers/resend';
import { isAllowed } from '@/lib/allowlist';

// Split out from auth.ts so this config (providers/pages/callbacks/session) can be
// imported directly in tests. auth.ts itself pulls in the top-level `next-auth`
// package (for NextAuth()) which fails to resolve under vitest's node environment
// (next-auth/lib/env.js imports 'next/server', which vitest can't resolve) — so
// tests must not import auth.ts. This module has no such import and is test-safe.
// It also does not construct the adapter (which needs getDb()) — auth.ts adds that.
export const authConfig = {
  providers: [Resend({ from: process.env.EMAIL_FROM })],
  pages: { signIn: '/admin/login' },
  session: { maxAge: 7 * 24 * 60 * 60 },
  callbacks: {
    signIn({ user }) {
      return isAllowed(user?.email, process.env.ADMIN_ALLOWLIST);
    },
  },
} satisfies NextAuthConfig;
