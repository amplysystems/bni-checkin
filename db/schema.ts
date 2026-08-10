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
  // Phase 2 Task 6 visitor-form addition: the selected "Who invited you?"
  // answer — either an active member's fullName (free text, not a FK; the
  // kiosk form snapshots the name at submit time same as every other
  // visitor-supplied field) or one of the fixed non-member options ('Found
  // us online', 'Referral', 'Other'). Null for anyone who isn't a visitor
  // (members/leadership never see this field) or a pre-Task-6 visitor row.
  // lib/emails/compile.ts groups this meeting's visitors by it for the
  // weekly report's VISITOR SOURCES line.
  invitedBy: text('invited_by'),
  // Phase 2 Task 6 two-visit kiosk rule admin override: set true from the
  // roster's quiet "Allow another visit" action, consumed (set back false)
  // by the NEXT checkIn() call for this person that would otherwise be
  // refused with CheckInError('visit_limit') — see lib/checkins.ts. One
  // flip authorizes exactly one extra visit, not indefinite bypass.
  allowExtraVisit: boolean('allow_extra_visit').notNull().default(false),
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
  //
  // 'weekly_export' (Task 5 carry-in "latest weekly export linked"):
  // lib/emails/export.ts's runWeeklyExport records itself as a row here,
  // AFTER a successful send, purely so the admin email center (Task 5) has
  // something to read "when did the last export go out" from — this type
  // never flows through lib/emails/engine.ts's state machine (it's written
  // directly in state 'sent', never draft/awaiting_approval/scheduled) and
  // has no meetingId.
  //
  // 'rsvp_notice' (Task 6): the one-time "{fullName} plans to visit
  // Wednesday" / "{fullName} is interested in membership" notification to
  // the owner, fired by app/rsvp/[token]/page.tsx on a token's first view.
  // Like approval_notice, it's a real email_messages row (not a
  // side-channel notification) so send_key `rsvp_notice:{token}` gives it
  // the same double-send-is-impossible guarantee as everything else — and
  // like weekly_export, it has no meetingId (an RSVP token outlives any
  // single meeting's compile).
  type: text('type', {
    enum: ['leadership_report', 'visitor_thankyou', 'approval_notice', 'weekly_export', 'rsvp_notice'],
  }).notNull(),
  meetingId: uuid('meeting_id').references(() => meetings.id),
  recipients: jsonb('recipients').$type<string[]>().notNull(),
  subject: text('subject').notNull(),
  bodySnapshot: text('body_snapshot'),
  state: text('state', {
    enum: ['draft', 'awaiting_approval', 'approved', 'scheduled', 'sending', 'sent', 'failed'],
  }).notNull().default('draft'),
  providerMessageId: text('provider_message_id'),
  // Phase 2 Task 7 (Resend delivery webhooks) additive column — null until
  // the FIRST webhook event for this message's providerMessageId arrives
  // (a 'sent' message with no webhook yet, or one sent before the webhook
  // was configured at all, both read as "unknown," not "sent" — see
  // app/api/admin/emails/route.ts's GET, which only renders a delivery chip
  // when this is non-null). Written exclusively by
  // lib/emails/webhook.ts's forward-only-guarded UPDATE — nothing else in
  // the engine ever sets it, and even that guarded UPDATE only ever moves
  // it to a higher-ranked status (see DELIVERY_STATUS_RANK there), never
  // backward — a duplicated or out-of-order webhook delivery (Resend is
  // at-least-once and unordered per spec §7) can't regress an already-known
  // 'delivered' back to 'sent'.
  deliveryStatus: text('delivery_status', {
    enum: ['sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed'],
  }),
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
  check(
    'email_messages_type_check',
    sql`${t.type} IN ('leadership_report', 'visitor_thankyou', 'approval_notice', 'weekly_export', 'rsvp_notice')`,
  ),
  check(
    'email_messages_state_check',
    sql`${t.state} IN ('draft', 'awaiting_approval', 'approved', 'scheduled', 'sending', 'sent', 'failed')`,
  ),
  check(
    'email_messages_delivery_status_check',
    sql`${t.deliveryStatus} IN ('sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed')`,
  ),
]);

// Phase 2 Task 6 one-tap RSVP / interest-capture tokens. One row grants
// access to the public, unauthenticated /rsvp/[token] page — the token
// itself IS the auth, so this table intentionally carries no secret beyond
// the token's own randomness (defaultRandom() -> a v4 UUID, unguessable).
// 'rsvp' (v1 thank-you CTA) and 'interest' (v2 conversion CTA) are the same
// page/route with different copy, distinguished by `purpose`. targetDate is
// always the NEXT meeting date, computed once at compile time
// (lib/emails/compile.ts) rather than re-derived on every page view, so the
// confirmation text a visitor sees always describes the meeting the email
// was actually sent for even if they click the link days later.
//
// uniq_rsvp_token_target (personId, purpose, targetDate): makes token
// creation idempotent — lib/emails/rsvp-tokens.ts's getOrCreateRsvpToken
// reuses the same token across repeated compiles for the same
// person+purpose+meeting (an admin re-previewing, or a cron tick calling
// createDrafts twice) instead of minting a fresh row, and a live one-time
// link, every call.
export const rsvpTokens = pgTable('rsvp_tokens', {
  token: uuid('token').primaryKey().defaultRandom(),
  personId: uuid('person_id').notNull().references(() => people.id),
  purpose: text('purpose', { enum: ['rsvp', 'interest'] }).notNull(),
  targetDate: date('target_date').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Null until the link is first opened; lib/emails/... firstUsedAt is what
  // gates the one-time owner notification (app/rsvp/[token]/page.tsx sets it
  // on first render, not here) — a null read is never itself a write.
  firstUsedAt: timestamp('first_used_at', { withTimezone: true }),
}, (t) => [
  check('rsvp_tokens_purpose_check', sql`${t.purpose} IN ('rsvp', 'interest')`),
  uniqueIndex('uniq_rsvp_token_target').on(t.personId, t.purpose, t.targetDate),
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
  // Phase 2 Task 8 (P2-6 carry-in): the RSVP owner-notification's optional
  // second recipient. Two columns, not one — there was never a place to
  // enter Carey's actual address, so the toggle alone would have nothing to
  // notify. lib/emails/engine.ts's ensureRsvpNotice only adds careyEmail to
  // the notification's recipients when BOTH rsvpNotifyCarey is true AND
  // careyEmail is non-null; the admin email-center toggle (app/admin/
  // admin-client.tsx) mirrors that same pairing client-side (disabled with
  // "Add Carey's email first" until an address is on file) and
  // app/api/admin/settings' POST enforces it server-side too, so the two
  // columns can never end up meaningfully split (toggle on, no address) via
  // any path that goes through this app.
  rsvpNotifyCarey: boolean('rsvp_notify_carey').notNull().default(false),
  careyEmail: text('carey_email'),
  // Migration 0008 (Phase 2 admin Test Lab / safe-mode toggle): a
  // UI-controllable override for whether outbound email gets redirected to
  // the owner's inbox. NULL (the default — no admin has ever touched the
  // toggle) means "follow lib/emails/send.ts's existing env-based logic
  // unchanged"; true/false is an explicit override written by the Email
  // settings "Test mode (safe mode)" toggle and always wins over the env
  // default. Nullable rather than a plain boolean specifically so "never
  // configured" stays distinguishable from "explicitly forced off" — see
  // isSafeModeActive's own comment for why that distinction matters (a
  // fresh/reset deployment must still default to safe, not silently start
  // sending to real people because a boolean column defaulted to false).
  emailSafeMode: boolean('email_safe_mode'),
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
export type RsvpToken = typeof rsvpTokens.$inferSelect;
