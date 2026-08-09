import NextAuth from 'next-auth';
import Resend from 'next-auth/providers/resend';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { getDb } from '@/lib/db';
import { users, accounts, sessions, verificationTokens } from '@/db/schema';
import { isAllowed } from '@/lib/allowlist';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [Resend({ from: process.env.EMAIL_FROM })],
  pages: { signIn: '/admin/login' },
  callbacks: {
    signIn({ user }) {
      return isAllowed(user?.email, process.env.ADMIN_ALLOWLIST);
    },
  },
});
