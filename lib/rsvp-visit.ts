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

export type RsvpVisitResolution =
  | { status: 'invalid' }
  | {
      status: 'valid';
      purpose: RsvpPurpose;
      firstName: string;
      meetingDateLabel: string;
      targetDateStr: string;
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

  return {
    status: 'valid',
    purpose: row.purpose,
    firstName: firstNameOf(row.personFullName),
    meetingDateLabel: formatMeetingDateLabel(row.targetDate),
    targetDateStr: row.targetDate,
  };
}
