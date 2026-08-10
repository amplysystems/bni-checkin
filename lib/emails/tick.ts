// The email cron tick's orchestration — what Netlify's email-cron.mts
// scheduled function ultimately triggers, via app/api/cron/email-tick's
// route (a thin HTTP+secret wrapper around runEmailTick below). This module
// owns NO email_messages writes itself; every write happens inside
// lib/emails/engine.ts's exported functions (reapStaleSending,
// createDrafts, ensureApprovalNotice, executeDue) — this file only decides
// WHEN to call them, in what order, gated on the Chicago wall-clock and
// whether today actually has a real (attended) meeting worth compiling
// drafts for. "Do NOT reimplement the state machine" — this is that rule
// applied: every mutation is a call into engine.ts.
//
// Order matters and mirrors the plan's numbered steps:
//   1. Reap anything stuck 'sending' from a crashed-mid-send tick, first —
//      so a stale claim never blocks a legitimate retry attempted later in
//      this same tick.
//   2. If it's on/after 16:45 CT on a day with a real (attended) meeting,
//      ensure today's drafts are compiled (idempotent by send_key).
//   3. If approve-mode is on and this meeting's drafts are awaiting
//      approval, fire the one-time "drafts ready" notice to the owner
//      (idempotent by its own send_key).
//   4. Sweep every message whose scheduled send time has passed, globally
//      — not just today's meeting (a late approval on an older message
//      should still go out). This is the step that actually sends.
//
// Every step is independently idempotent (see each engine.ts function's own
// doc comment), so running this whole sequence twice in a row — exactly
// what a duplicated or overlapping cron trigger does — reduces to a no-op
// on the second pass: identical DB state, zero extra sends.

import type { Db } from '@/lib/db';
import { findMeetingByDate, meetingHasAttendance } from '@/lib/meetings';
import { chicagoWallClock } from '@/lib/time';
import {
  createDrafts, ensureApprovalNotice, executeDue, reapStaleSending,
} from './engine';

// 16:45 CT — "compile drafts ~4:45 PM" per the plan (meetings run 3:30-4:30
// PM CT; the earliest default send time, thankyouSendTime, is 17:30 CT —
// this leaves 45 minutes of drafts sitting compiled/awaiting-approval
// before the earliest possible send).
const DRAFT_COMPILE_HOUR = 16;
const DRAFT_COMPILE_MINUTE = 45;

function atOrAfterDraftCompileTime(wall: { hour: number; minute: number }): boolean {
  return wall.hour > DRAFT_COMPILE_HOUR
    || (wall.hour === DRAFT_COMPILE_HOUR && wall.minute >= DRAFT_COMPILE_MINUTE);
}

export type EmailTickResult = {
  reapedCount: number;
  meetingId: string | null;
  draftsCreated: number;
  draftsSkipped: number;
  approvalNoticeSent: boolean;
  sentCount: number;
};

export async function runEmailTick(db: Db, now: Date = new Date()): Promise<EmailTickResult> {
  const reaped = await reapStaleSending(db, now);

  let meetingId: string | null = null;
  let draftsCreated = 0;
  let draftsSkipped = 0;
  let approvalNoticeSent = false;

  const wall = chicagoWallClock(now);
  if (atOrAfterDraftCompileTime(wall)) {
    const meeting = await findMeetingByDate(db, wall.dateStr);
    if (meeting && meeting.status !== 'canceled' && await meetingHasAttendance(db, meeting.id)) {
      meetingId = meeting.id;

      const { created, skipped } = await createDrafts(db, meeting.id);
      draftsCreated = created.length;
      draftsSkipped = skipped;

      const notice = await ensureApprovalNotice(db, meeting.id);
      approvalNoticeSent = notice?.state === 'sent';
    }
  }

  const sent = await executeDue(db, now);

  return {
    reapedCount: reaped.length,
    meetingId,
    draftsCreated,
    draftsSkipped,
    approvalNoticeSent,
    sentCount: sent.length,
  };
}
