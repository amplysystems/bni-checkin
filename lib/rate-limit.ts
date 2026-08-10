import { lt, sql } from 'drizzle-orm';
import { rateLimits } from '@/db/schema';
import type { Db } from '@/lib/db';

export type RateLimitConfig = { route: string; limit: number; windowMinutes: number };

export type RateLimitInput = RateLimitConfig & { ip: string; now?: Date };

export type RateLimitResult = { allowed: boolean; count: number };

// Named per-route budgets for the kiosk POST endpoints (spec §13 hard
// prerequisite for the email-sending tasks). All windows are per-IP/hour;
// kept together here rather than scattered across the three route files so
// the actual numbers are reviewable in one place.
export const KIOSK_RATE_LIMITS = {
  visitor: { route: 'visitor', limit: 5, windowMinutes: 60 },
  checkin: { route: 'checkin', limit: 40, windowMinutes: 60 },
  undo: { route: 'undo', limit: 40, windowMinutes: 60 },
} as const satisfies Record<string, RateLimitConfig>;

// Cleanup is opportunistic: most calls skip it, and the ones that run it
// fire-and-forget rather than block the caller's request on a sweep.
// RETENTION_MS only needs to comfortably outlive the longest windowMinutes
// in use (60 today) — 2 hours leaves ample margin against clock skew
// between serverless instances.
const CLEANUP_PROBABILITY = 0.02;
const CLEANUP_RETENTION_MS = 2 * 60 * 60 * 1000;

function windowStartFor(now: Date, windowMinutes: number): Date {
  const ms = windowMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

// Deletes rate_limits rows whose window is old enough that nothing could
// still be reading or incrementing them. Exported (rather than folded into
// checkRateLimit's random gate) so it's independently testable and so a
// caller with its own maintenance cron could invoke it deterministically.
export async function cleanupExpiredRateLimits(db: Db, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - CLEANUP_RETENTION_MS);
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, cutoff));
}

// Race-tolerant per-IP+route limiter, durable across serverless instances
// via one DB row per (ip, route, window). A single upsert statement — no
// db.transaction() (throws at runtime on the neon-http driver, see
// lib/db.ts) — Postgres applies ON CONFLICT DO UPDATE atomically per row,
// so two concurrent callers racing the same window still land a correct,
// serialized count rather than both reading-then-writing count=1.
export async function checkRateLimit(db: Db, input: RateLimitInput): Promise<RateLimitResult> {
  const now = input.now ?? new Date();
  const windowStart = windowStartFor(now, input.windowMinutes);
  const key = `${input.ip}:${input.route}:${windowStart.toISOString()}`;

  const [row] = await db.insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1` } })
    .returning();

  if (Math.random() < CLEANUP_PROBABILITY) {
    // Best-effort: a failed sweep must never fail the request it rode in on.
    cleanupExpiredRateLimits(db, now).catch((err) => {
      console.error('rate-limit cleanup failed', err);
    });
  }

  return { allowed: row.count <= input.limit, count: row.count };
}

// IP resolution order: Netlify's connection header (set at the edge, not
// client-spoofable) → first hop of x-forwarded-for (may originate from an
// untrusted proxy, but still narrows abuse to whatever IP it claims) →
// 'unknown', which intentionally shares ONE bucket across every caller
// that supplies neither header — a coarser limit, not a bypass.
export function getClientIp(req: Request): string {
  const nf = req.headers.get('x-nf-client-connection-ip');
  if (nf && nf.trim()) return nf.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
