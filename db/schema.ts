import { sql } from 'drizzle-orm';
import {
  pgTable, text, uuid, timestamp, integer, boolean, date, jsonb,
  primaryKey, uniqueIndex,
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
}, (t) => [primaryKey({ columns: [t.personId, t.role] })]);

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  personId: uuid('person_id').notNull().references(() => people.id),
  status: text('status', { enum: ['visitor', 'member', 'former_member'] }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export const meetings = pgTable('meetings', {
  id: uuid('id').primaryKey().defaultRandom(),
  meetingDate: date('meeting_date').notNull().unique(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  status: text('status', { enum: ['scheduled', 'canceled', 'special'] }).notNull().default('scheduled'),
  title: text('title'),
  notes: text('notes'),
});

export const attendance = pgTable('attendance', {
  id: uuid('id').primaryKey().defaultRandom(),
  personId: uuid('person_id').notNull().references(() => people.id),
  meetingId: uuid('meeting_id').notNull().references(() => meetings.id),
  kind: text('kind', { enum: ['member', 'leadership', 'visitor'] }).notNull(),
  visitNumber: integer('visit_number'),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }).notNull().defaultNow(),
  checkedInBy: text('checked_in_by').notNull(),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: text('voided_by'),
  clientOpId: text('client_op_id').unique(),
}, (t) => [
  uniqueIndex('uniq_active_attendance').on(t.personId, t.meetingId).where(sql`${t.voidedAt} IS NULL`),
]);

export const emailMessages = pgTable('email_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sendKey: text('send_key').notNull().unique(),
  type: text('type', { enum: ['leadership_report', 'visitor_thankyou'] }).notNull(),
  meetingId: uuid('meeting_id').references(() => meetings.id),
  recipients: jsonb('recipients').notNull(),
  subject: text('subject').notNull(),
  bodySnapshot: text('body_snapshot'),
  state: text('state', {
    enum: ['draft', 'awaiting_approval', 'approved', 'scheduled', 'sending', 'sent', 'failed'],
  }).notNull().default('draft'),
  providerMessageId: text('provider_message_id'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emailEvents = pgTable('email_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerEventId: text('provider_event_id').notNull().unique(),
  messageId: uuid('message_id').references(() => emailMessages.id),
  eventType: text('event_type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  payload: jsonb('payload'),
});

export const settings = pgTable('settings', {
  id: integer('id').primaryKey(),
  approveMode: boolean('approve_mode').notNull().default(true),
  reportSendTime: text('report_send_time').notNull().default('18:00'),
  thankyouSendTime: text('thankyou_send_time').notNull().default('17:30'),
  reportRecipients: jsonb('report_recipients').notNull().default(sql`'[]'::jsonb`),
  openSeats: jsonb('open_seats').notNull().default(sql`'[]'::jsonb`),
});

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
