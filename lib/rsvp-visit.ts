// Orchestrates a single view of the public /rsvp/[token] page (Phase 2
// Task 6): look up the token, and — on its first-ever view only — mark it
// used and fire the owner notification. Lives outside lib/emails/ on
// purpose: it needs BOTH lib/emails/rsvp-tokens.ts (token CRUD) and
// lib/emails/engine.ts (ensureRsvpNotice, which itself depends on
// lib/emails/compile.ts), and engine.ts already depends on compile.ts —
// putting this orchestration inside lib/emails/ would risk a cycle the
// moment anything in that directory needed it back. app/rsvp/[token]/
// page.tsx is the only caller; keeping the DB + side-effect logic here
// (rather than inline in the page component) makes it testable without
// rendering React.

import type { Db } from '@/lib/db';
import { findRsvpToken, markRsvpTokenUsed, type RsvpPurpose } from '@/lib/emails/rsvp-tokens';
import { ensureRsvpNotice } from '@/lib/emails/engine';
import { firstNameOf, formatMeetingDateLabel } from '@/lib/emails/compile';
import { chicagoDateString } from '@/lib/time';
import { nextWednesday } from '@/lib/emails/ics';

export type RsvpVisitResolution =
  | { status: 'invalid' }
  | {
      status: 'valid';
      purpose: RsvpPurpose;
      firstName: string;
      meetingDateLabel: string;
      targetDateStr: string;
      // P2-6 carry-in: true when the token's originally-compiled targetDate
      // has already gone by (the link was opened late) — see below.
      passed: boolean;
    };

// `now` is injectable for tests; every real caller (the page component)
// uses the default.
export async function resolveRsvpVisit(db: Db, tokenParam: string, now: Date = new Date()): Promise<RsvpVisitResolution> {
  const row = await findRsvpToken(db, tokenParam);
  if (!row) return { status: 'invalid' };

  // markRsvpTokenUsed's own guarded UPDATE (WHERE first_used_at IS NULL) is
  // what actually decides "is this the first view" — calling it
  // unconditionally here (rather than branching on row.firstUsedAt first)
  // avoids a check-then-act race between reading the row above and writing
  // below; only the caller whose UPDATE actually claims a still-null row
  // gets true back, so ensureRsvpNotice below can only ever be reached
  // once per token regardless of how many requests arrive concurrently.
  const justUsed = await markRsvpTokenUsed(db, tokenParam, now);
  if (justUsed) {
    await ensureRsvpNotice(db, { token: row.token, purpose: row.purpose, personFullName: row.personFullName });
  }

  // P2-6 carry-in: the token's targetDate is fixed at compile time (this
  // meeting's date + 7 — db/schema.ts's own comment) and never updated
  // afterward. A link opened late enough that the meeting it names has
  // already happened would otherwise confirm a stale, already-past date —
  // once that's true, point everything (the headline AND all three
  // calendar actions) at the literal next meeting from right now instead.
  const todayStr = chicagoDateString(now);
  const passed = row.targetDate < todayStr;
  const targetDateStr = passed ? nextWednesday(now) : row.targetDate;

  return {
    status: 'valid',
    purpose: row.purpose,
    firstName: firstNameOf(row.personFullName),
    meetingDateLabel: formatMeetingDateLabel(targetDateStr),
    targetDateStr,
    passed,
  };
}
