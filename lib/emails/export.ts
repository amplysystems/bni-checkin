// Weekly logical export (spec §12, backup/DR) — a JSON dump of the
// chapter's OPERATIONAL data (roster, attendance, membership/role history,
// email send-state, settings), emailed to the owner as an attachment via
// lib/emails/send.ts's single choke point, so SAFE_MODE's
// redirect-and-prefix discipline still runs on this send even though the
// recipient is already the owner (see send.ts's header comment for why
// nothing bypasses it). Triggered weekly by netlify/functions/
// weekly-export.mts via app/api/cron/weekly-export/route.ts, same
// CRON_SECRET guard as the email tick.
//
// CORRECTION (review): this is NOT "every application table" — it's the
// seven listed in dumpTables() below (people, meetings, attendance,
// memberships, personRoles, emailMessages, settings). Explicitly excluded,
// by name, and why:
//   - rate_limits: ephemeral kiosk rate-limiter state (lib/rate-limit.ts).
//     Ambient — it self-heals every window rollover and carries no
//     information worth restoring; including it would just be noise in a
//     DR-focused export.
//   - email_events: Resend webhook delivery-status events (spec §7). Not
//     yet populated by anything — Task 7 builds the webhook handler that
//     writes to this table. REVISIT once Task 7 lands: delivery history is
//     genuinely operational data (bounce tracking) and probably belongs in
//     this export once it exists.
//   - users / accounts / sessions / verification_tokens: Auth.js identity
//     and session state. Out of scope for chapter-data DR on two
//     independent grounds — (1) it's re-derivable (magic-link sign-in
//     needs no restore, just a fresh login) rather than being source-of-
//     truth chapter data, and (2) sessions/verification_tokens hold
//     bearer-style tokens that have no business sitting in a JSON
//     attachment in an inbox.
//
// DECISION (documented per the task): storage is email-attachment-only.
// Spec §12 also names Netlify Blobs as a second storage leg; this task
// explicitly skips it — Blobs would add a second read/auth/retention path
// for a backup mechanism whose primary consumer ("Jason has the file, in
// storage he controls by definition") the email attachment alone already
// satisfies per spec §12's own framing. Revisit only if a restore is ever
// actually blocked on "the inbox copy is gone too."
//
// bodySnapshot is deliberately excluded from the email_messages dump: it
// can be large (the full compiled HTML per message) and isn't needed for
// the disaster-recovery scenarios in scope (rebuilding roster/attendance/
// send-state, not replaying old outbound mail content).

import {
  attendance, emailMessages, meetings, memberships, people, personRoles, settings as settingsTable,
} from '@/db/schema';
import type { Db } from '@/lib/db';
import { chicagoDateString } from '@/lib/time';
import { OWNER_EMAIL } from './constants';
import { weeklyExportSendKey } from './send-keys';
import { sendEmailMessage } from './send';

async function dumpTables(db: Db) {
  const [
    peopleRows, meetingRows, attendanceRows, membershipRows, personRoleRows, emailMessageRows, settingsRows,
  ] = await Promise.all([
    db.select().from(people),
    db.select().from(meetings),
    db.select().from(attendance),
    db.select().from(memberships),
    db.select().from(personRoles),
    db.select({
      id: emailMessages.id,
      sendKey: emailMessages.sendKey,
      type: emailMessages.type,
      meetingId: emailMessages.meetingId,
      recipients: emailMessages.recipients,
      subject: emailMessages.subject,
      // bodySnapshot intentionally omitted — see module header.
      state: emailMessages.state,
      providerMessageId: emailMessages.providerMessageId,
      approvedBy: emailMessages.approvedBy,
      approvedAt: emailMessages.approvedAt,
      sendingAt: emailMessages.sendingAt,
      sentAt: emailMessages.sentAt,
      error: emailMessages.error,
      createdAt: emailMessages.createdAt,
    }).from(emailMessages),
    db.select().from(settingsTable),
  ]);

  return {
    people: peopleRows,
    meetings: meetingRows,
    attendance: attendanceRows,
    memberships: membershipRows,
    personRoles: personRoleRows,
    emailMessages: emailMessageRows,
    settings: settingsRows,
  };
}

function exportSubject(dateStr: string): string {
  return `BNI Wheeling — weekly data export, ${dateStr}`;
}

function countsLines(counts: Record<string, number>): string[] {
  return Object.entries(counts).map(([table, n]) => `${table}: ${n}`);
}

function exportHtml(dateStr: string, counts: Record<string, number>): string {
  const rows = countsLines(counts).map((line) => `<li>${line}</li>`).join('');
  return `<p>Weekly backup export for ${dateStr} (spec &sect;12).</p><ul>${rows}</ul><p>Full data is attached as JSON.</p>`;
}

function exportText(dateStr: string, counts: Record<string, number>): string {
  return [
    `Weekly backup export for ${dateStr} (spec §12).`,
    '',
    ...countsLines(counts).map((line) => `  ${line}`),
    '',
    'Full data is attached as JSON.',
  ].join('\n');
}

export type WeeklyExportResult = {
  tableCounts: Record<string, number>;
  providerMessageId: string;
};

export async function runWeeklyExport(db: Db, now: Date = new Date()): Promise<WeeklyExportResult> {
  const dateStr = chicagoDateString(now);
  const tables = await dumpTables(db);
  const tableCounts = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [name, rows.length]),
  );

  const json = JSON.stringify({ generatedAt: now.toISOString(), tables }, null, 2);
  const attachment = {
    filename: `bni-checkin-export-${dateStr}.json`,
    content: Buffer.from(json, 'utf-8').toString('base64'),
  };

  const subject = exportSubject(dateStr);
  const html = exportHtml(dateStr, tableCounts);

  const result = await sendEmailMessage({
    type: 'weekly_export',
    sendKey: weeklyExportSendKey(dateStr),
    recipients: [OWNER_EMAIL],
    subject,
    html,
    text: exportText(dateStr, tableCounts),
    attachments: [attachment],
  }, now);

  // Task 5 carry-in ("latest weekly export linked"): record this send as a
  // real email_messages row so the admin email center has something to
  // read. Written AFTER the send succeeds (never a pre-send 'draft' row —
  // this type never enters lib/emails/engine.ts's state machine at all),
  // and only after dumpTables() already ran above, so this week's own row
  // is never included in the JSON attachment it's documenting.
  // onConflictDoNothing on the per-day send_key: a duplicated cron trigger
  // still sends twice (an accepted pre-existing gap — see this module's
  // header), but only ever leaves one row behind for the day, so "latest
  // export" reads never see a spurious duplicate.
  await db.insert(emailMessages).values({
    sendKey: weeklyExportSendKey(dateStr),
    type: 'weekly_export',
    meetingId: null,
    recipients: [OWNER_EMAIL],
    subject,
    bodySnapshot: html,
    state: 'sent',
    sentAt: now,
    providerMessageId: result.providerMessageId,
  }).onConflictDoNothing({ target: emailMessages.sendKey });

  return { tableCounts, providerMessageId: result.providerMessageId };
}
