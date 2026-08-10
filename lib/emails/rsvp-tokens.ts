// CRUD for the rsvp_tokens table (Phase 2 Task 6) — token minting at
// compile time (getOrCreateRsvpToken, called from lib/emails/compile.ts)
// and lookup/first-use tracking for the public /rsvp/[token] page
// (findRsvpToken, markRsvpTokenUsed, called from lib/rsvp-visit.ts).
//
// Deliberately no dependency on lib/emails/engine.ts here (which would
// create an import cycle: engine.ts -> compile.ts -> rsvp-tokens.ts ->
// engine.ts) — the "fire the owner notification on first use" orchestration
// that DOES need engine.ts lives one layer up, in lib/rsvp-visit.ts.

import { and, eq, isNull } from 'drizzle-orm';
import { people, rsvpTokens, type RsvpToken } from '@/db/schema';
import type { Db } from '@/lib/db';

export type RsvpPurpose = 'rsvp' | 'interest';

// v4 UUID, case-insensitive — matches what defaultRandom() actually
// generates and what Postgres' uuid column accepts. Checked BEFORE any
// query touches the DB: an eq() on a uuid column with a non-UUID string
// throws a raw Postgres "invalid input syntax for type uuid" error rather
// than just finding no rows, and a malformed/garbage path segment (a typo,
// a bot probing URLs) must resolve to the same friendly "invalid" page as
// a well-formed-but-unknown token, not a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidTokenFormat(token: string): boolean {
  return UUID_RE.test(token);
}

// Idempotent per (personId, purpose, targetDate) via uniq_rsvp_token_target
// (db/schema.ts) — a repeated compile for the same meeting (an admin
// re-clicking Preview, or a cron tick's createDrafts running twice; see
// lib/emails/compile.ts's own header) reuses the SAME live token/link
// rather than minting a fresh one and orphaning the previous copy still
// sitting in an already-sent email.
export async function getOrCreateRsvpToken(
  db: Db,
  { personId, purpose, targetDate }: { personId: string; purpose: RsvpPurpose; targetDate: string },
): Promise<string> {
  const [inserted] = await db.insert(rsvpTokens).values({ personId, purpose, targetDate })
    .onConflictDoNothing({ target: [rsvpTokens.personId, rsvpTokens.purpose, rsvpTokens.targetDate] })
    .returning({ token: rsvpTokens.token });
  if (inserted) return inserted.token;

  const [existing] = await db.select({ token: rsvpTokens.token }).from(rsvpTokens).where(and(
    eq(rsvpTokens.personId, personId),
    eq(rsvpTokens.purpose, purpose),
    eq(rsvpTokens.targetDate, targetDate),
  ));
  return existing.token;
}

export type RsvpTokenWithPerson = RsvpToken & { personFullName: string };

// Read-only lookup joined with the token's person (for firstName
// derivation only — see lib/rsvp-visit.ts; the page itself must never
// render the full name or any contact info). Returns null for a
// well-formed-but-unknown token exactly the same as a malformed one — the
// caller collapses both to the same friendly "invalid" page, never an error
// code that would let a prober distinguish "doesn't exist" from "expired."
export async function findRsvpToken(db: Db, token: string): Promise<RsvpTokenWithPerson | null> {
  if (!isValidTokenFormat(token)) return null;
  const [row] = await db.select({
    token: rsvpTokens.token,
    personId: rsvpTokens.personId,
    purpose: rsvpTokens.purpose,
    targetDate: rsvpTokens.targetDate,
    createdAt: rsvpTokens.createdAt,
    firstUsedAt: rsvpTokens.firstUsedAt,
    personFullName: people.fullName,
  }).from(rsvpTokens)
    .innerJoin(people, eq(people.id, rsvpTokens.personId))
    .where(eq(rsvpTokens.token, token));
  return row ?? null;
}

// Single-statement guarded UPDATE (same pattern as lib/checkins.ts's
// allowExtraVisit consumption and every state-scoped transition in
// lib/emails/engine.ts) — WHERE first_used_at IS NULL means only ONE
// concurrent caller (two tabs opening the same link at once, a link
// preview bot racing the real click) ever observes justUsed:true and
// therefore ever fires the owner notification.
export async function markRsvpTokenUsed(db: Db, token: string, now: Date = new Date()): Promise<boolean> {
  const [claimed] = await db.update(rsvpTokens)
    .set({ firstUsedAt: now })
    .where(and(eq(rsvpTokens.token, token), isNull(rsvpTokens.firstUsedAt)))
    .returning({ token: rsvpTokens.token });
  return claimed !== undefined;
}
