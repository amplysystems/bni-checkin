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
//
// Sizing rationale (security review, 2026-08-09):
//  - The kiosk sits at a single venue behind one shared IP for ALL foot
//    traffic on a given Wednesday — every visitor, member, and leadership
//    tap hits the limiter under the SAME 'ip' bucket, not one bucket per
//    person. A budget sized for "one abusive individual" would rate-limit
//    the chapter's own meeting.
//  - The visitor route's two-phase confirm flow (suggestMatches surfaces
//    near-match suggestions on the first POST; the visitor then confirms
//    "new" with confirmedNew:true on a second POST) means one real
//    registration can cost 2 POSTs against this route's budget. 25/hr is
//    sized for that: a strong visitor day (~12 registrations, all
//    double-charging) fits with headroom.
//  - confirmedNew:true is deliberately NOT exempted from the count — an
//    attacker would simply always set it, so exempting it would just hand
//    back the original tighter budget to anyone who knows the flag.
//    Charging every POST unconditionally and sizing the cap to absorb the
//    legitimate double-charge is the version of this that's both hard to
//    bypass and generous enough for a real Wednesday.
//  - checkin/undo stay at 40/hr — those are per-tap (not per-registration)
//    and shared across the whole room's worth of check-ins/undos in an
//    hour, which 40 covers comfortably at the current roster size.
//  - Accepted residual: these are fixed windows, not sliding ones, so
//    traffic straddling an hour boundary (e.g. a burst just before 5:00 PM
//    plus another just after) can see up to ~2x the nominal limit over a
//    couple of minutes. Not worth a sliding-window implementation for a
//    once-a-week, single-venue kiosk — see the break-glass reset
//    (app/api/admin/rate-limits/route.ts) for the manual escape hatch if a
//    limit ever trips live.
//  - Revisit these numbers if the roster approaches 40 people — checkin/
//    undo's headroom shrinks once one checkin-plus-undo per person becomes
//    a plausible single hour of traffic.
export const KIOSK_RATE_LIMITS = {
  visitor: { route: 'visitor', limit: 25, windowMinutes: 60 },
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

// Longest plausible textual IP: IPv6's max form (8 groups of 4 hex digits +
// 7 colons = 39 chars) plus slack for a zone id. Anything longer in an XFF
// hop, or anything containing whitespace (a header-injection/garbage value,
// not a real address), isn't a client IP worth trusting as a rate-limit key.
const MAX_IP_LENGTH = 45;

function isPlausibleIp(candidate: string): boolean {
  return candidate.length > 0 && candidate.length <= MAX_IP_LENGTH && !/\s/.test(candidate);
}

// IP resolution order: Netlify's connection header (set at the edge, not
// client-spoofable) → first hop of x-forwarded-for (may originate from an
// untrusted proxy — isPlausibleIp only guards against obviously-malformed
// values there; a spoofed-but-well-formed IP still narrows abuse to
// whatever address it claims) → 'unknown', which intentionally shares ONE
// bucket across every caller that supplies neither header — a coarser
// limit, not a bypass.
//
// Netlify standard functions always set x-nf-client-connection-ip, so
// falling through past it should be ~never in production — logged as a
// warning so any occurrence is visible. Production-only: local dev and the
// test suite construct bare Requests with no headers constantly, which
// would otherwise turn this into noise instead of signal.
export function getClientIp(req: Request): string {
  const nf = req.headers.get('x-nf-client-connection-ip')?.trim();
  if (nf) return nf;

  if (process.env.NODE_ENV === 'production') {
    console.warn('rate-limit: x-nf-client-connection-ip missing — falling back to x-forwarded-for');
  }

  const fwd = req.headers.get('x-forwarded-for');
  const first = fwd?.split(',')[0]?.trim();
  if (first && isPlausibleIp(first)) return first;

  if (process.env.NODE_ENV === 'production') {
    console.warn('rate-limit: no usable client IP header — falling back to the shared "unknown" bucket');
  }
  return 'unknown';
}
