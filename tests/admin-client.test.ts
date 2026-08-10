// Task 8: unit tests for the PURE, exported helper functions in
// app/admin/admin-client.tsx. This is a 'use client' React component file,
// but nothing at module scope touches the DOM or React hooks — only the
// functions actually called below run at all, so importing it from a plain
// node-environment vitest test (no jsdom/testing-library in this repo) is
// safe. No JSX is rendered anywhere in this file.
import { describe, it, expect } from 'vitest';
import {
  attendanceErrorMessage, changeStatusErrorMessage, compileErrorMessage, groupEmailMessages,
} from '@/app/admin/admin-client';

describe('attendanceErrorMessage', () => {
  it('maps visit_limit (P2-6 carry-in) to plain language pointing at Allow another visit', () => {
    expect(attendanceErrorMessage({ status: 400, error: 'visit_limit' })).toBe(
      "They've used their two visitor meetings — use Allow another visit in the roster first.",
    );
  });

  it('still maps the other known 400 codes and falls back to the generic message', () => {
    expect(attendanceErrorMessage({ status: 400, error: 'person_deactivated' }))
      .toBe("Can't check in — that person is deactivated.");
    expect(attendanceErrorMessage({ status: 400, error: 'person_not_found' }))
      .toBe('Person not found — refreshing.');
    expect(attendanceErrorMessage({ status: 400, error: 'something_else' }))
      .toBe('Something went wrong — try again.');
    expect(attendanceErrorMessage({ status: 409 })).toBe('Conflict — try again.');
    expect(attendanceErrorMessage({ status: 404 })).toBe('Already voided or not found — refreshing.');
    expect(attendanceErrorMessage({ status: 500 })).toBe('Something went wrong — try again.');
  });
});

describe('changeStatusErrorMessage', () => {
  it('maps person_deactivated, falls back to generic otherwise', () => {
    expect(changeStatusErrorMessage({ status: 400, error: 'person_deactivated' }))
      .toBe("Can't change status — that person is deactivated.");
    expect(changeStatusErrorMessage({ status: 500 })).toBe('Something went wrong — try again.');
  });
});

// The "Get emails ready" (compile) action used to show the generic
// "Something went wrong" toast on EVERY failure, even though the compile
// route (app/api/admin/emails' POST action=compile) already returns
// readable prose for its 400s ("That meeting was canceled." / "That
// meeting has no check-ins yet…"). compileErrorMessage is what fixes that —
// it surfaces the route's own error text instead of masking it.
describe('compileErrorMessage', () => {
  it('surfaces the route\'s own plain-English 400 text verbatim', () => {
    expect(compileErrorMessage({ status: 400, error: 'That meeting was canceled.' }))
      .toBe('That meeting was canceled.');
    expect(compileErrorMessage({
      status: 400, error: 'That meeting has no check-ins yet — emails get ready on their own once people check in.',
    })).toBe('That meeting has no check-ins yet — emails get ready on their own once people check in.');
  });

  it('404 (no meeting on that date at all) keeps its own dedicated message', () => {
    expect(compileErrorMessage({ status: 404 })).toBe('No meeting on that date — check the date and try again.');
  });

  it('falls back to the generic message for a 400 with no error text, or any other status', () => {
    expect(compileErrorMessage({ status: 400 })).toBe('Something went wrong — try again.');
    expect(compileErrorMessage({ status: 500 })).toBe('Something went wrong — try again.');
    expect(compileErrorMessage({ status: 0 })).toBe('Something went wrong — try again.');
  });
});

describe('groupEmailMessages (P2-6 carry-in: Notifications vs Weekly exports pseudo-groups)', () => {
  type EmailType = 'leadership_report' | 'visitor_thankyou' | 'approval_notice' | 'weekly_export' | 'rsvp_notice';
  type EmailState = 'draft' | 'awaiting_approval' | 'approved' | 'scheduled' | 'sending' | 'sent' | 'failed';
  type Row = ReturnType<typeof msg>;
  function msg(overrides: Partial<{
    id: string; type: EmailType; meetingId: string | null; meetingDate: string | null;
    label: string; state: EmailState;
  }>) {
    return {
      id: overrides.id ?? 'id-1',
      type: overrides.type ?? 'leadership_report',
      label: overrides.label ?? 'Weekly report',
      state: overrides.state ?? 'sent',
      meetingId: overrides.meetingId ?? null,
      meetingDate: overrides.meetingDate ?? null,
      recipientsCount: 1,
      subject: 'subject',
      scheduledFor: null,
      sentAt: null,
      error: null,
      providerMessageId: null,
      deliveryStatus: null,
      createdAt: '2026-08-12T00:00:00.000Z',
    };
  }

  it('rsvp_notice rows land in their own "notifications" group, distinct from weekly_export\'s "exports" group', () => {
    const messages: Row[] = [
      msg({ id: 'notice-1', type: 'rsvp_notice', label: 'RSVP notice', meetingId: null }),
      msg({ id: 'export-1', type: 'weekly_export', label: 'Weekly export', meetingId: null }),
    ];
    const groups = groupEmailMessages(messages);
    expect(groups).toHaveLength(2);

    const notifications = groups.find((g) => g.messages.some((m) => m.type === 'rsvp_notice'))!;
    const exports = groups.find((g) => g.messages.some((m) => m.type === 'weekly_export'))!;
    expect(notifications).not.toBe(exports);
    expect(notifications.messages).toHaveLength(1);
    expect(exports.messages).toHaveLength(1);
    // Never merged into the same group (both have meetingId: null, but that
    // alone must not collapse them together).
    expect(notifications.messages[0].id).toBe('notice-1');
    expect(exports.messages[0].id).toBe('export-1');
  });

  it('meeting-scoped groups still sort most-recent-first, ahead of both non-meeting pseudo-groups', () => {
    const messages: Row[] = [
      msg({ id: 'older', type: 'leadership_report', meetingId: 'm-old', meetingDate: '2026-08-05' }),
      msg({ id: 'newer', type: 'leadership_report', meetingId: 'm-new', meetingDate: '2026-08-12' }),
      msg({ id: 'notice-1', type: 'rsvp_notice', meetingId: null }),
      msg({ id: 'export-1', type: 'weekly_export', meetingId: null }),
    ];
    const groups = groupEmailMessages(messages);
    expect(groups.map((g) => g.messages[0].id)).toEqual(['newer', 'older', 'notice-1', 'export-1']);
  });

  it('multiple rsvp_notice rows collapse into ONE notifications group, not one per row', () => {
    const messages: Row[] = [
      msg({ id: 'n1', type: 'rsvp_notice' }),
      msg({ id: 'n2', type: 'rsvp_notice' }),
      msg({ id: 'n3', type: 'rsvp_notice' }),
    ];
    const groups = groupEmailMessages(messages);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(3);
  });
});
