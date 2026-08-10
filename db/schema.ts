import { sql } from 'drizzle-orm';
import {
  pgTable, text, uuid, timestamp, integer, boolean, date, jsonb,
  primaryKey, uniqueIndex, index, check,
} from 'drizzle-orm/pg-core';
import type { AdapterAccountType } from 'next-auth/adapters';

export const people = pgTable('people', {
  id: uuid('id').primaryKey().defaultRandom(),
  fullName: text('full_name').notNull(),
  displayName: text('display_name'),
  industry: text('industry'),
  company: text('company'),
  email: text('email'),
  phone: text('phone'),
  notes: text('notes'),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const personRoles = pgTable('person_roles', {
  personId: uuid('person_id').notNull().references(() => people.id),
  role: text('role', { enum: ['leadership', 'admin_contact'] }).notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.personId, t.role] }),
  check('person_roles_role_check', sql`${t.role} IN ('leadership', 'admin_contact')`),
]);

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  personId: uuid('person_id').notNull().references(() => people.id),
  status: text('status', { enum: ['visitor', 'member', 'former_member'] }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('uniq_open_membership').on(t.personId).where(sql`${t.endedAt} IS NULL`),
  index('idx_memberships_person').on(t.personId),
  check('memberships_status_check', sql`${t.status} IN ('visitor', 'member', 'former_member')`),
]);

export const meetings = pgTable('meetings', {
  id: uuid('id').primaryKey().defaultRandom(),
  meetingDate: date('meeting_date').notNull().unique(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  status: text('status', { enum: ['scheduled', 'canceled', 'special'] }).notNull().default('scheduled'),
  title: text('title'),
  notes: text('notes'),
}, (t) => [
  check('meetings_status_check', sql`${t.status} IN ('scheduled', 'canceled', 'special')`),
]);

export const attendance = pgTable('attendance', {
  id: uuid('id').primaryKey().defaultRandom(),
  personId: uuid('person_id').notNull().references(() => people.id),
  meetingId: uuid('meeting_id').notNull().references(() => meetings.id),
  kind: text('kind', { enum: ['member', 'leadership', 'visitor'] }).notNull(),
  visitNumber: integer('visit_number'),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }).notNull().defaultNow(),
  // free text by design: 'kiosk' or 'admin:{email}' — kiosk check-ins have no authenticated user
  checkedInBy: text('checked_in_by').notNull(),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: text('voided_by'),
  clientOpId: text('client_op_id').unique(),
}, (t) => [
  uniqueIndex('uniq_active_attendance').on(t.personId, t.meetingId).where(sql`${t.voidedAt} IS NULL`),
  index('idx_attendance_meeting').on(t.meetingId),
  check('attendance_kind_check', sql`${t.kind} IN ('member', 'leadership', 'visitor')`),
]);

// Per-IP request throttling for kiosk POST routes. One row per (ip, route,
// window) — see lib/rate-limit.ts for the upsert-increment logic that keeps
// this race-tolerant without db.transaction() (throws at runtime on
// neon-http). Key embeds all three parts so a single PK lookup does the
// job; window_start is read only by the opportunistic cleanup sweep, which
// is a fine full-scan at this table's scale (no separate index needed).
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(1),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
});

export const emailMessages = pgTable('email_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sendKey: text('send_key').notNull().unique(),
  // 'approval_notice' (Phase 2 Task 4 / P2-3 carry-in): the one-time
  // "drafts ready to approve" email to the owner, created + sent by
  // lib/emails/engine.ts's ensureApprovalNotice — a real email_messages row
  // (not a side-channel notification) so its send_key gives it the exact
  // same double-send-is-impossible guarantee as everything else.
  type: text('type', { enum: ['leadership_report', 'visitor_thankyou', 'approval_notice'] }).notNull(),
  meetingId: uuid('meeting_id').references(() => meetings.id),
  recipients: jsonb('recipients').$type<string[]>().notNull(),
  subject: text('subject').notNull(),
  bodySnapshot: text('body_snapshot'),
  state: text('state', {
    enum: ['draft', 'awaiting_approval', 'approved', 'scheduled', 'sending', 'sent', 'failed'],
  }).notNull().default('draft'),
  providerMessageId: text('provider_message_id'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  // Stamped the instant a row is claimed into 'sending' (both claimAndSend
  // and claimFromAnyPreSendState in lib/emails/engine.ts set it). Exists
  // solely so the cron tick's stale-sending reaper (reapStaleSending) can
  // tell "just started sending" from "died mid-send 20 minutes ago" —
  // nothing else reads it.
  sendingAt: timestamp('sending_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('email_messages_type_check', sql`${t.type} IN ('leadership_report', 'visitor_thankyou', 'approval_notice')`),
  check(
    'email_messages_state_check',
    sql`${t.state} IN ('draft', 'awaiting_approval', 'approved', 'scheduled', 'sending', 'sent', 'failed')`,
  ),
]);

export const emailEvents = pgTable('email_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerEventId: text('provider_event_id').notNull().unique(),
  messageId: uuid('message_id').references(() => emailMessages.id),
  eventType: text('event_type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  payload: jsonb('payload').$type<unknown>(),
});

export const settings = pgTable('settings', {
  id: integer('id').primaryKey(),
  approveMode: boolean('approve_mode').notNull().default(true),
  // Spec §5 defaults: visitor thank-you 5:00 PM CT, leadership report 5:30
  // PM CT. Migration 0003 corrects these from the original (wrong) schema
  // defaults ('18:00'/'17:30') — see that migration's header for the
  // winter-DST bug those wrong values caused.
  reportSendTime: text('report_send_time').notNull().default('17:30'),
  thankyouSendTime: text('thankyou_send_time').notNull().default('17:00'),
  reportRecipients: jsonb('report_recipients').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  openSeats: jsonb('open_seats').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
}, (t) => [
  check('settings_singleton', sql`${t.id} = 1`),
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { withTimezone: true }),
  image: text('image'),
});

export const accounts = pgTable('accounts', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').$type<AdapterAccountType>().notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: integer('expires_at'),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
}, (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })]);

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable('verification_tokens', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.identifier, t.token] })]);

export type Person = typeof people.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
export type EmailMessage = typeof emailMessages.$inferSelect;
