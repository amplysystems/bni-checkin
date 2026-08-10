// Six-digit sign-in code (OTP) core logic — kept as pure-ish functions (db
// first arg, injectable `now`) so the interesting behavior (lifecycle,
// single-use, expiry, allowlist re-check, session creation) is unit-testable
// without going through a Next.js server action. The action wrapper
// (app/admin/login/page.tsx) stays a thin adapter over this module: parse
// FormData, resolve request-scoped bits (headers/cookies), call in, set the
// cookie, redirect.
//
// Why this exists: the installed iOS/desktop PWA has its own cookie jar
// separate from Mail/Safari, so tapping the emailed magic link opens the
// browser's session, not the app's — an admin on the home-screen app can
// never complete that flow. The email now also carries a 6-digit code the
// admin can type directly into the installed app, which posts it here.
import { randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { sessions, users, verificationTokens } from '@/db/schema';
import { isAllowed } from '@/lib/allowlist';
import { isUniqueViolation } from '@/lib/checkins';
import type { Db } from '@/lib/db';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 15 * 60 * 1000;

// verificationTokens is shared with Auth.js's own link-based flow (it's the
// adapter's verificationTokensTable). `otp:{email}` can never collide with a
// real Auth.js token (those are 32-byte random hex strings — see
// randomString(32) in @auth/core's send-token.ts — which never contain the
// literal prefix "otp:"), so the two flows can safely share the table.
function otpIdentifier(email: string): string {
  return `otp:${email}`;
}

export function normalizeOtpEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateCode(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

// Never store the raw code — sha256(`${code}:${secret}`) hex, same shape as
// Auth.js's own verification-token hash (see @auth/core's send-token.ts,
// which hashes `${token}${secret}`). Keying the hash off AUTH_SECRET means a
// DB leak alone (without the app's secret) doesn't hand out working codes.
function hashCode(code: string, secret: string): string {
  return createHash('sha256').update(`${code}:${secret}`).digest('hex');
}

// Both operands are always the hex digest of a sha256 (64 hex chars / 32
// bytes) produced by hashCode above, so the length check never itself leaks
// information — it's just what timingSafeEqual requires to not throw.
function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Generates a fresh code, stores its hash, and returns the PLAINTEXT code to
// the caller (lib/auth-config.ts's sendVerificationRequest) so it can be
// dropped into the outgoing email — the plaintext is never persisted.
// Deletes any existing otp:{email} row first: one active code per address,
// so an admin who requests two emails in a row only ever has the latest one
// work. Single DELETE + single INSERT, no db.transaction() (throws at
// runtime on the neon-http driver — see lib/db.ts).
export async function generateAndStoreOtp(
  db: Db,
  email: string,
  secret: string,
  now: Date = new Date(),
): Promise<string> {
  const identifier = otpIdentifier(normalizeOtpEmail(email));
  await db.delete(verificationTokens).where(eq(verificationTokens.identifier, identifier));
  const code = generateCode();
  await db.insert(verificationTokens).values({
    identifier,
    token: hashCode(code, secret),
    expires: new Date(now.getTime() + OTP_TTL_MS),
  });
  return code;
}

export type OtpFailureReason = 'not_allowed' | 'unknown' | 'expired' | 'mismatch';

export type OtpVerifyResult =
  | { ok: true; sessionToken: string; userId: string; expires: Date }
  | { ok: false; reason: OtpFailureReason };

export type VerifyOtpInput = {
  email: string;
  code: string;
  secret: string;
  allowlist: string | undefined;
  sessionMaxAgeSeconds: number;
};

// Session cookie name/options Auth.js v5 reads for a DATABASE-strategy
// session — verified directly against the installed @auth/core source
// (node_modules/@auth/core/src/lib/utils/cookie.ts's `defaultCookies`, and
// its cookie-expiry handling in
// node_modules/@auth/core/src/lib/actions/callback/index.ts), not from
// docs, because a mismatch here would silently break every session this
// module creates — Auth.js would simply never see the cookie.
//   - name: `${useSecureCookies ? '__Secure-' : ''}authjs.session-token`
//     useSecureCookies = `config.useSecureCookies ?? url.protocol === 'https:'`
//     (@auth/core/src/lib/init.ts:109). lib/auth-config.ts never sets
//     useSecureCookies, so it always follows the request/site protocol.
//   - options: httpOnly: true, sameSite: 'lax', path: '/',
//     secure: useSecureCookies (fixed by defaultCookies) — plus `expires`,
//     which the callback handler sets to `now + session.maxAge` seconds
//     (session.maxAge = 7 days here, see lib/auth-config.ts), mirrored via
//     the `expires` param below.
export function sessionCookieName(useSecureCookies: boolean): string {
  return `${useSecureCookies ? '__Secure-' : ''}authjs.session-token`;
}

export function sessionCookieOptions(useSecureCookies: boolean, expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: useSecureCookies,
    expires,
  };
}

// Verifies a submitted code and, on success, creates a real Auth.js
// database session row (find-or-create the user first, matching the
// DrizzleAdapter's own shape — see node_modules/@auth/drizzle-adapter/lib/
// pg.js's createUser/getUserByEmail). The caller (the verifyCode server
// action) is responsible for actually setting the session cookie using
// sessionCookieName/sessionCookieOptions above.
//
// Attempt-limiting choice: rather than a per-code attempt counter (5
// guesses), the row is deleted on ANY read — match or not. One guess per
// emailed code makes brute force impossible without needing extra state,
// at the minor UX cost that a typo burns the code and requires a fresh
// email. See the task notes / commit message for this tradeoff.
export async function verifyOtpAndCreateSession(
  db: Db,
  input: VerifyOtpInput,
  now: Date = new Date(),
): Promise<OtpVerifyResult> {
  const email = normalizeOtpEmail(input.email);

  // Defense in depth: the code can only ever exist in the DB because the
  // signIn callback (lib/auth-config.ts) already allowlisted this address
  // before sendVerificationRequest ran (verified against @auth/core's
  // send-token.ts: callbacks.signIn runs and can throw AccessDenied BEFORE
  // provider.sendVerificationRequest is ever called) — but this path must
  // not rely on that alone. Checked FIRST, before any DB access, and its
  // failure returns the exact same result shape as every other failure
  // reason so this endpoint can't be used as an allowlist oracle.
  if (!isAllowed(email, input.allowlist)) return { ok: false, reason: 'not_allowed' };

  const identifier = otpIdentifier(email);
  const [row] = await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, identifier));
  if (!row) return { ok: false, reason: 'unknown' };

  // Single-use / single-guess (see attempt-limiting comment on the export
  // above): consume the row now, before even checking whether it matches.
  await db.delete(verificationTokens).where(
    and(eq(verificationTokens.identifier, identifier), eq(verificationTokens.token, row.token)),
  );

  if (row.expires.getTime() < now.getTime()) return { ok: false, reason: 'expired' };

  const suppliedHash = hashCode(input.code, input.secret);
  if (!hashesEqual(suppliedHash, row.token)) return { ok: false, reason: 'mismatch' };

  let [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    try {
      [user] = await db.insert(users).values({ email, emailVerified: now }).returning();
    } catch (err) {
      // Lost a create race against a concurrent verify/link sign-in for the
      // same address (users.email is unique) — the winner's row is now
      // there to read.
      if (!isUniqueViolation(err)) throw err;
      [user] = await db.select().from(users).where(eq(users.email, email));
    }
  } else if (!user.emailVerified) {
    [user] = await db.update(users).set({ emailVerified: now }).where(eq(users.id, user.id)).returning();
  }
  if (!user) throw new Error('otp: failed to find or create user for verified code');

  const sessionToken = randomUUID();
  const expires = new Date(now.getTime() + input.sessionMaxAgeSeconds * 1000);
  await db.insert(sessions).values({ sessionToken, userId: user.id, expires });

  return { ok: true, sessionToken, userId: user.id, expires };
}
