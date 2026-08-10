import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/db';
import { sessions, users, verificationTokens } from '@/db/schema';
import {
  generateAndStoreOtp,
  normalizeOtpEmail,
  sessionCookieName,
  sessionCookieOptions,
  verifyOtpAndCreateSession,
} from '@/lib/otp';

const SECRET = 'test-auth-secret';
const ALLOWLIST = 'admin@bniwheeling.test, second@bniwheeling.test';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // mirrors authConfig.session.maxAge

async function rowFor(db: Awaited<ReturnType<typeof createTestDb>>, email: string) {
  const rows = await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, `otp:${email}`));
  return rows[0];
}

describe('generateAndStoreOtp', () => {
  it('generates a zero-padded six-digit code and stores only its hash', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-10T12:00:00Z');
    const code = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET, now);

    expect(code).toMatch(/^\d{6}$/);

    const row = await rowFor(db, 'admin@bniwheeling.test');
    expect(row).toBeDefined();
    expect(row.token).not.toBe(code);
    expect(row.token).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
    expect(row.expires.getTime()).toBe(now.getTime() + 15 * 60 * 1000);
  });

  it('normalizes the email (trim/lowercase) into the stored identifier', async () => {
    const db = await createTestDb();
    await generateAndStoreOtp(db, '  Admin@BNIWheeling.test  ', SECRET);
    const row = await rowFor(db, 'admin@bniwheeling.test');
    expect(row).toBeDefined();
  });

  it('keeps only one active code per address — a second send replaces the first', async () => {
    const db = await createTestDb();
    const first = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET);
    const second = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET);
    expect(first).not.toBe(second); // astronomically unlikely to collide; a false failure here is not a code bug

    const rows = await db.select().from(verificationTokens).where(eq(verificationTokens.identifier, 'otp:admin@bniwheeling.test'));
    expect(rows.length).toBe(1);

    // The first code no longer verifies — only the latest one is live.
    const result = await verifyOtpAndCreateSession(db, {
      email: 'admin@bniwheeling.test',
      code: first,
      secret: SECRET,
      allowlist: ALLOWLIST,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    });
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('verifyOtpAndCreateSession', () => {
  it('succeeds for a correct code: single-use (row deleted), 7-day-mirrored session row, and returns the token', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-10T12:00:00Z');
    const code = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET, now);

    const result = await verifyOtpAndCreateSession(db, {
      email: 'admin@bniwheeling.test',
      code,
      secret: SECRET,
      allowlist: ALLOWLIST,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    }, now);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.sessionToken).toMatch(/^[0-9a-f-]{36}$/); // crypto.randomUUID()
    expect(result.expires.getTime()).toBe(now.getTime() + SESSION_MAX_AGE * 1000);

    // Single-use: the code row is gone.
    expect(await rowFor(db, 'admin@bniwheeling.test')).toBeUndefined();

    // A real sessions row exists with the returned token, matching userId/expiry.
    const [sessionRow] = await db.select().from(sessions).where(eq(sessions.sessionToken, result.sessionToken));
    expect(sessionRow).toBeDefined();
    expect(sessionRow.userId).toBe(result.userId);
    expect(sessionRow.expires.getTime()).toBe(now.getTime() + SESSION_MAX_AGE * 1000);

    // find-or-create: a brand new user row was created, matching the
    // Auth.js DrizzleAdapter shape (emailVerified stamped to `now`).
    const [userRow] = await db.select().from(users).where(eq(users.email, 'admin@bniwheeling.test'));
    expect(userRow).toBeDefined();
    expect(userRow.id).toBe(result.userId);
    expect(userRow.emailVerified?.getTime()).toBe(now.getTime());
  });

  it('reuses an existing user row instead of creating a duplicate, and stamps emailVerified if it was unset', async () => {
    const db = await createTestDb();
    const [existing] = await db.insert(users).values({ email: 'admin@bniwheeling.test', emailVerified: null }).returning();
    const now = new Date('2026-08-10T12:00:00Z');
    const code = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET, now);

    const result = await verifyOtpAndCreateSession(db, {
      email: 'admin@bniwheeling.test',
      code,
      secret: SECRET,
      allowlist: ALLOWLIST,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    }, now);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.userId).toBe(existing.id);

    const allUsers = await db.select().from(users).where(eq(users.email, 'admin@bniwheeling.test'));
    expect(allUsers.length).toBe(1); // no duplicate created
    expect(allUsers[0].emailVerified?.getTime()).toBe(now.getTime());
  });

  it('rejects and deletes the code on a wrong guess (single guess per code)', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-10T12:00:00Z');
    const code = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET, now);
    const wrongCode = code === '000000' ? '000001' : '000000';

    const first = await verifyOtpAndCreateSession(db, {
      email: 'admin@bniwheeling.test',
      code: wrongCode,
      secret: SECRET,
      allowlist: ALLOWLIST,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    }, now);
    expect(first).toEqual({ ok: false, reason: 'mismatch' });
    expect(await rowFor(db, 'admin@bniwheeling.test')).toBeUndefined();

    // The correct code no longer works either — the row is gone regardless
    // of which guess consumed it.
    const second = await verifyOtpAndCreateSession(db, {
      email: 'admin@bniwheeling.test',
      code,
      secret: SECRET,
      allowlist: ALLOWLIST,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    }, now);
    expect(second).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an expired code (and consumes it)', async () => {
    const db = await createTestDb();
    const sentAt = new Date('2026-08-10T12:00:00Z');
    const code = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET, sentAt);

    const justAfterExpiry = new Date(sentAt.getTime() + 15 * 60 * 1000 + 1);
    const result = await verifyOtpAndCreateSession(db, {
      email: 'admin@bniwheeling.test',
      code,
      secret: SECRET,
      allowlist: ALLOWLIST,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    }, justAfterExpiry);

    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(await rowFor(db, 'admin@bniwheeling.test')).toBeUndefined();
  });

  it('accepts a code at the exact expiry boundary (not-yet-expired)', async () => {
    const db = await createTestDb();
    const sentAt = new Date('2026-08-10T12:00:00Z');
    const code = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET, sentAt);
    const exactExpiry = new Date(sentAt.getTime() + 15 * 60 * 1000);

    const result = await verifyOtpAndCreateSession(db, {
      email: 'admin@bniwheeling.test',
      code,
      secret: SECRET,
      allowlist: ALLOWLIST,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    }, exactExpiry);

    expect(result.ok).toBe(true);
  });

  it('rejects an unknown email (no code was ever sent) without creating anything', async () => {
    const db = await createTestDb();
    // Allowlisted but never sent a code — distinct from the not_allowed
    // case above; this exercises the "row missing" branch specifically.
    const result = await verifyOtpAndCreateSession(db, {
      email: 'second@bniwheeling.test',
      code: '123456',
      secret: SECRET,
      allowlist: ALLOWLIST,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    });
    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(sessions)).toEqual([]);
  });

  it('rejects an un-allowlisted email even with the exact valid code, and never touches the code row', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-10T12:00:00Z');
    const code = await generateAndStoreOtp(db, 'intruder@evil.test', SECRET, now);

    const result = await verifyOtpAndCreateSession(db, {
      email: 'intruder@evil.test',
      code,
      secret: SECRET,
      allowlist: ALLOWLIST, // does not contain intruder@evil.test
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    }, now);

    expect(result).toEqual({ ok: false, reason: 'not_allowed' });
    // Fails before touching the DB at all — the code is still there,
    // unconsumed, proving the allowlist check runs first and short-circuits.
    expect(await rowFor(db, 'intruder@evil.test')).toBeDefined();
  });

  it('rejects an un-allowlisted email when the allowlist env is unset entirely', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-10T12:00:00Z');
    const code = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET, now);

    const result = await verifyOtpAndCreateSession(db, {
      email: 'admin@bniwheeling.test',
      code,
      secret: SECRET,
      allowlist: undefined,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    }, now);

    expect(result).toEqual({ ok: false, reason: 'not_allowed' });
  });

  it('normalizes email case/whitespace the same way on verify as on generate', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-10T12:00:00Z');
    const code = await generateAndStoreOtp(db, 'admin@bniwheeling.test', SECRET, now);

    const result = await verifyOtpAndCreateSession(db, {
      email: '  Admin@BNIWheeling.TEST ',
      code,
      secret: SECRET,
      allowlist: ALLOWLIST,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
    }, now);

    expect(result.ok).toBe(true);
  });
});

describe('normalizeOtpEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeOtpEmail('  Foo@Bar.COM  ')).toBe('foo@bar.com');
  });
});

// Session cookie name/options Auth.js v5 reads for a DATABASE-strategy
// session, as verified directly in node_modules/@auth/core (installed
// version 0.41.3) rather than assumed from docs:
//   - node_modules/@auth/core/src/lib/utils/cookie.ts `defaultCookies`:
//     name = `${useSecureCookies ? '__Secure-' : ''}authjs.session-token`;
//     options = { httpOnly: true, sameSite: 'lax', path: '/', secure: useSecureCookies }
//   - node_modules/@auth/core/src/lib/init.ts:109:
//     useSecureCookies = config.useSecureCookies ?? url.protocol === 'https:'
//   - node_modules/@auth/core/src/lib/actions/callback/index.ts: on a
//     successful sign-in it additionally sets `expires` on the cookie to
//     `now + sessionMaxAge` seconds (sessionMaxAge from session.maxAge).
// A mismatch in name or any option here would mean Auth.js's own session
// helpers (auth(), the proxy) silently never see the cookie this endpoint
// sets — hence pinning it here against the documented source, not just
// eyeballing it once.
describe('session cookie name/options (must match @auth/core exactly)', () => {
  it('uses the __Secure- prefixed name when useSecureCookies is true', () => {
    expect(sessionCookieName(true)).toBe('__Secure-authjs.session-token');
  });

  it('uses the bare name when useSecureCookies is false', () => {
    expect(sessionCookieName(false)).toBe('authjs.session-token');
  });

  it('sets httpOnly/sameSite/path/secure exactly as @auth/core defaultCookies does, plus the given expires', () => {
    const expires = new Date('2026-08-17T12:00:00Z');
    expect(sessionCookieOptions(true, expires)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
      expires,
    });
    expect(sessionCookieOptions(false, expires)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
      expires,
    });
  });
});
