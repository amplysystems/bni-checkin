'use client';

import { useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';

// ---- Types (mirrored from the admin API route contracts) ----------------

type PersonStatus = 'leadership' | 'member' | 'visitor' | 'former_member' | 'none';

type AdminPerson = {
  id: string;
  fullName: string;
  displayName: string | null;
  industry: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  deactivatedAt: string | null;
  createdAt: string;
  status: PersonStatus;
  // Phase 2 Task 6 two-visit kiosk rule: total non-voided visitor-kind
  // visits (0 for anyone who's never been a visitor) and whether an admin
  // has already armed the one-time override — both computed server-side
  // (app/api/admin/roster/route.ts's GET), not derived client-side.
  visitCount: number;
  allowExtraVisit: boolean;
  // Phase 2 Task 7: true when a visitor_thankyou email to this person's
  // current roster email bounced (email-match heuristic, computed
  // server-side — see that route's GET for the reasoning).
  emailBounced: boolean;
};

type RosterResponse = { people: AdminPerson[] };

type AttendanceRow = {
  id: string;
  personId: string;
  kind: 'member' | 'leadership' | 'visitor';
  visitNumber: number | null;
  checkedInAt: string;
  checkedInBy: string;
  fullName: string;
};

type AttendanceResponse = { meetingDate: string; attendance: AttendanceRow[] };

type MeetingAttendee = {
  personId: string;
  fullName: string;
  kind: 'member' | 'leadership' | 'visitor';
  visitNumber: number | null;
};

type AdminMeeting = {
  id: string;
  meetingDate: string;
  status: string;
  total: number;
  memberCount: number;
  leadershipCount: number;
  visitorCount: number;
  attendees: MeetingAttendee[];
};

// Task 8: "Show earlier" pagination — hasMore tells the panel whether
// there's another page worth offering a button for.
type MeetingsResponse = { meetings: AdminMeeting[]; hasMore: boolean };

// ---- Emails (Phase 2 Task 5) types (mirrored from app/api/admin/emails and
// app/api/admin/settings' contracts) --------------------------------------

type EmailType = 'leadership_report' | 'visitor_thankyou' | 'approval_notice' | 'weekly_export' | 'rsvp_notice';
type EmailState = 'draft' | 'awaiting_approval' | 'approved' | 'scheduled' | 'sending' | 'sent' | 'failed';
// Phase 2 Task 7: null until the first Resend webhook event for this
// message lands (see db/schema.ts's delivery_status column comment).
type DeliveryStatus = 'sent' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed';

type EmailMessageRow = {
  id: string;
  type: EmailType;
  label: string;
  state: EmailState;
  meetingId: string | null;
  meetingDate: string | null;
  recipientsCount: number;
  subject: string;
  scheduledFor: string | null;
  sentAt: string | null;
  error: string | null;
  providerMessageId: string | null;
  deliveryStatus: DeliveryStatus | null;
  createdAt: string;
};

type EmailsResponse = { messages: EmailMessageRow[]; safeMode: boolean };

type EmailSettings = {
  approveMode: boolean;
  reportSendTime: string;
  thankyouSendTime: string;
  reportRecipients: string[];
  // P2-6 carry-in (Task 8): the RSVP owner-notification's optional second
  // recipient — see db/schema.ts's rsvpNotifyCarey/careyEmail comment for
  // why this is two fields, not one.
  rsvpNotifyCarey: boolean;
  careyEmail: string | null;
};

type SettingsResponse = { settings: EmailSettings };

type CreateStatus = 'member' | 'leadership' | 'visitor';

type PersonFormState = {
  fullName: string;
  industry: string;
  company: string;
  email: string;
  phone: string;
  status: CreateStatus;
};

const emptyForm: PersonFormState = {
  fullName: '', industry: '', company: '', email: '', phone: '', status: 'member',
};

type DialogState = { mode: 'create' } | { mode: 'edit'; person: AdminPerson } | null;

type LoadResult =
  | {
      ok: true; people: AdminPerson[]; attendance: AttendanceRow[]; meetingDate: string;
      meetings: AdminMeeting[]; meetingsHasMore: boolean;
      emailMessages: EmailMessageRow[]; emailSettings: EmailSettings; emailSafeMode: boolean;
    }
  | { ok: false };

const GENERIC_ERROR = 'Something went wrong — try again.';
const SAVE_CONNECTION_ERROR = "Couldn't save — check the connection and try again.";
const TOAST_MS = 2_500;

// Brand-red background buttons (Save, + Add person, …) now go through
// components/ui/button.tsx's `primary` variant, which owns the literal
// bg-[#CF2030] class itself — no local BRAND_RED constant needed here
// anymore.
//
// #CF2030 as TEXT (not background) fails WCAG on dark surfaces: measured
// ~3.3:1 against neutral-900/neutral-950, short of the 4.5:1 minimum for
// normal text. Inline `style` can't express a `dark:` variant, so red text
// (the dialog's inline error banner, which isn't a button) uses this literal
// Tailwind arbitrary-value pair instead — computed contrast for #F0595F
// against both surfaces is ~5.4:1 (neutral-900) and ~5.9:1 (neutral-950).
// Written as a literal string, not built from a JS constant, because
// Tailwind's build-time scanner only sees raw source text, not evaluated
// JS — a template-interpolated class name is invisible to it.
const RED_TEXT_CLASS = 'text-[#CF2030] dark:text-[#F0595F]';

const ADMIN_INPUT_CLASS =
  'w-full rounded-xl border border-neutral-200 bg-transparent px-4 py-2.5 text-[15px] text-neutral-900 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:text-neutral-100 dark:focus:border-neutral-600';

// 'none' previously used text-neutral-400/500 on a bare dashed border with no
// fill — measured ~2.5:1 on a white card, well under the 4.5:1 minimum.
// Given a subtle bg + ring (like the other badges' solid fills) and darker
// text so it clears contrast in both themes while still reading as visually
// "lesser than" a real status.
const STATUS_META: Record<PersonStatus, { label: string; className: string }> = {
  leadership: { label: 'Leadership', className: 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' },
  member: { label: 'Member', className: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300' },
  visitor: { label: 'Visitor', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  former_member: { label: 'Former member', className: 'border border-dashed border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400' },
  none: { label: 'None', className: 'bg-neutral-50 text-neutral-600 ring-1 ring-inset ring-neutral-300 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700' },
};

// Elements the Tab-trap in PersonDialog cycles between — deliberately not a
// library, just the standard focusable-selector list.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ---- Small pure helpers ---------------------------------------------------

// Empty-string form fields mean "clear this optional field" — normalize to
// null so it matches the nullable columns the API accepts (and so the diff
// against the original person in buildUpdateFields below is stable).
function normalize(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function formatMeetingDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  }).format(dt);
}

function formToCreateFields(form: PersonFormState) {
  return {
    fullName: form.fullName.trim(),
    industry: normalize(form.industry),
    company: normalize(form.company),
    email: normalize(form.email),
    phone: normalize(form.phone),
  };
}

// Only the fields that actually changed vs. the person being edited — an
// empty result means "nothing to save," which the Save button below uses to
// stay disabled rather than firing a no-op PATCH (the API itself also
// rejects an empty fields object with 400, this just avoids the round trip).
function buildUpdateFields(form: PersonFormState, person: AdminPerson): Record<string, string | null> {
  const fields: Record<string, string | null> = {};
  if (form.fullName.trim() !== person.fullName) fields.fullName = form.fullName.trim();
  if (normalize(form.industry) !== person.industry) fields.industry = normalize(form.industry);
  if (normalize(form.company) !== person.company) fields.company = normalize(form.company);
  if (normalize(form.email) !== person.email) fields.email = normalize(form.email);
  if (normalize(form.phone) !== person.phone) fields.phone = normalize(form.phone);
  return fields;
}

// Edit-mode initial value for the status picker, and the baseline the Save
// flow diffs the picker against to decide whether a changeStatus call is
// needed at all. The picker only ever offers the three changeStatus targets
// (member/leadership/visitor); 'former_member' and 'none' have no
// corresponding option (lib/roster.ts's changeStatus never targets either),
// so they fall back to 'visitor' — the more conservative of the two
// "inactive-ish" starting points, since opening the dialog on one of these
// rare states never silently promotes the person into the member grid on
// an unrelated field-only save.
function editStatusDefault(status: PersonStatus): CreateStatus {
  if (status === 'leadership' || status === 'member' || status === 'visitor') return status;
  return 'visitor';
}

async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, status: res.status, error: errBody?.error };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function attendanceErrorMessage(result: { status: number; error?: string }): string {
  if (result.status === 400) {
    if (result.error === 'person_deactivated') return "Can't check in — that person is deactivated.";
    if (result.error === 'person_not_found') return 'Person not found — refreshing.';
    // P2-6 carry-in: lib/checkins.ts's CheckInError('visit_limit') reaches
    // here as a plain 400 with no further detail — point straight at the
    // fix (the roster row's "Allow another visit" action) instead of the
    // generic fallback below, which told an admin something went wrong
    // without saying what to actually do about it.
    if (result.error === 'visit_limit') {
      return "They've used their two visitor meetings — use Allow another visit in the roster first.";
    }
    return GENERIC_ERROR;
  }
  if (result.status === 409) return 'Conflict — try again.';
  if (result.status === 404) return 'Already voided or not found — refreshing.';
  return GENERIC_ERROR;
}

// Shared by both changeStatus call sites (the edit dialog's Save flow and
// the roster row's one-tap "Make member" action) — one POST helper so the
// two never drift on the action shape.
function changeStatusRequest(personId: string, to: CreateStatus) {
  return postJson<{ status: CreateStatus; changed: boolean }>('/api/admin/roster', {
    action: 'changeStatus', personId, to,
  });
}

export function changeStatusErrorMessage(result: { status: number; error?: string }): string {
  if (result.status === 400 && result.error === 'person_deactivated') {
    return "Can't change status — that person is deactivated.";
  }
  return GENERIC_ERROR;
}

// ---- Root component -----------------------------------------------------

export default function AdminClient({ adminEmail }: { adminEmail: string }) {
  const [people, setPeople] = useState<AdminPerson[] | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRow[] | null>(null);
  const [meetingDate, setMeetingDate] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<AdminMeeting[] | null>(null);
  // Task 8 "Show earlier" pagination: whether the server has more meetings
  // past what's currently loaded, and whether a page-2+ fetch is in flight.
  // Every loadAll() refresh (mount, or after any mutation) re-fetches just
  // page 1 and collapses back to it — see handleShowEarlierMeetings' own
  // comment for why that's the deliberate, simpler choice over trying to
  // preserve an expanded page count across an unrelated refresh.
  const [meetingsHasMore, setMeetingsHasMore] = useState(false);
  const [loadingMoreMeetings, setLoadingMoreMeetings] = useState(false);
  const [emailMessages, setEmailMessages] = useState<EmailMessageRow[] | null>(null);
  const [emailSettings, setEmailSettings] = useState<EmailSettings | null>(null);
  const [emailSafeMode, setEmailSafeMode] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [showDeactivated, setShowDeactivated] = useState(false);

  const [chipPendingId, setChipPendingId] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);
  const [makingMemberId, setMakingMemberId] = useState<string | null>(null);
  const [allowingExtraVisitId, setAllowingExtraVisitId] = useState<string | null>(null);
  const [resettingRateLimits, setResettingRateLimits] = useState(false);

  // ---- Emails section state (Phase 2 Task 5) ----
  const [previewMessage, setPreviewMessage] = useState<{ id: string; subject: string; html: string } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const previewPreviousFocusRef = useRef<HTMLElement | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [compileDate, setCompileDate] = useState('');
  const [compiling, setCompiling] = useState(false);
  // `settingsOverride` starts null and is written only once the admin
  // actually edits something; `settingsForm` (derived below, not its own
  // piece of state) falls back to the freshly-fetched emailSettings until
  // then. That derivation — rather than an effect that copies emailSettings
  // into local state on first load — avoids a setState-during-effect
  // cascade while still giving the form its own "life" once touched, same
  // idea as PersonDialog's `form` state just without a dialog wrapper.
  const [settingsOverride, setSettingsOverride] = useState<EmailSettings | null>(null);
  const settingsForm = settingsOverride ?? emailSettings;
  const updateSettingsForm = useCallback(
    (updater: (f: EmailSettings | null) => EmailSettings | null) => {
      setSettingsOverride((prev) => updater(prev ?? emailSettings));
    },
    [emailSettings],
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [recipientInput, setRecipientInput] = useState('');

  const [dialog, setDialog] = useState<DialogState>(null);
  const [form, setForm] = useState<PersonFormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The element that had focus right before a dialog opened (the "+ Add
  // person" button, a row's "Edit" button, …) — restored on every close path
  // (Cancel, overlay click, Escape, successful save) so keyboard/AT users
  // land back where they were instead of at <body>.
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text });
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // ---- Data loading ----
  // All three endpoints are fetched together on mount, whenever the "show
  // deactivated" toggle changes, and again after every mutation (attendance
  // toggle, person save, deactivate/reactivate, meeting mutations). Those
  // call sites don't coordinate with each other — a chip tap and a
  // Deactivate click can both be in flight at once — so a slow response from
  // an earlier request must never clobber a fresher one. loadRequestIdRef is
  // a monotonic counter shared by every call: each request stamps its
  // eventual response with the counter value at issue time, and
  // applyLoadResult discards any response whose stamp no longer matches the
  // current counter. Ported from the same pattern in
  // app/kiosk/kiosk-client.tsx.
  //
  // meetings folds into this same Promise.all + request-id guard (rather
  // than its own effect) so the Meetings panel refreshes for free whenever
  // the Today panel's counts change — no separate fetch wiring needed.
  const loadRequestIdRef = useRef(0);

  const fetchAdminData = useCallback(async (includeDeactivated: boolean): Promise<LoadResult> => {
    try {
      const rosterUrl = includeDeactivated ? '/api/admin/roster?includeDeactivated=1' : '/api/admin/roster';
      const [rosterRes, attRes, meetingsRes, emailsRes, settingsRes] = await Promise.all([
        fetch(rosterUrl),
        fetch('/api/admin/attendance'),
        fetch('/api/admin/meetings'),
        fetch('/api/admin/emails'),
        fetch('/api/admin/settings'),
      ]);
      if (!rosterRes.ok || !attRes.ok || !meetingsRes.ok || !emailsRes.ok || !settingsRes.ok) return { ok: false };
      const rosterData = (await rosterRes.json()) as RosterResponse;
      const attData = (await attRes.json()) as AttendanceResponse;
      const meetingsData = (await meetingsRes.json()) as MeetingsResponse;
      const emailsData = (await emailsRes.json()) as EmailsResponse;
      const settingsData = (await settingsRes.json()) as SettingsResponse;
      return {
        ok: true,
        people: rosterData.people,
        attendance: attData.attendance,
        meetingDate: attData.meetingDate,
        meetings: meetingsData.meetings,
        meetingsHasMore: meetingsData.hasMore,
        emailMessages: emailsData.messages,
        emailSettings: settingsData.settings,
        emailSafeMode: emailsData.safeMode,
      };
    } catch {
      return { ok: false };
    }
  }, []);

  const applyLoadResult = useCallback((requestId: number, result: LoadResult) => {
    if (requestId !== loadRequestIdRef.current) return; // superseded by a newer request
    if (result.ok) {
      setPeople(result.people);
      setAttendance(result.attendance);
      setMeetingDate(result.meetingDate);
      setMeetings(result.meetings);
      setMeetingsHasMore(result.meetingsHasMore);
      setEmailMessages(result.emailMessages);
      setEmailSettings(result.emailSettings);
      setEmailSafeMode(result.emailSafeMode);
      setLoadError(false);
    } else {
      setLoadError(true);
    }
  }, []);

  const loadAll = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    const result = await fetchAdminData(showDeactivated);
    applyLoadResult(requestId, result);
  }, [fetchAdminData, applyLoadResult, showDeactivated]);

  // Re-runs on mount and whenever loadAll's identity changes — which happens
  // whenever showDeactivated changes, so toggling "Show deactivated" refetches
  // with the right query param automatically.
  useEffect(() => {
    async function run() { await loadAll(); }
    run();
  }, [loadAll]);

  const attendanceByPerson = useMemo(
    () => new Map((attendance ?? []).map((a) => [a.personId, a])),
    [attendance],
  );

  // Deactivated people can never have a today's-attendance row going forward
  // (the API rejects check-ins for them), so the Today grid only ever shows
  // active people regardless of the roster panel's "show deactivated" toggle.
  const activePeople = useMemo(() => (people ?? []).filter((p) => p.deactivatedAt === null), [people]);

  // ---- Today panel: toggle check-in ----

  const toggleAttendance = useCallback(async (personId: string) => {
    if (chipPendingId) return;
    setChipPendingId(personId);
    const existing = attendanceByPerson.get(personId) ?? null;
    const result = existing
      ? await postJson<{ attendance: AttendanceRow }>('/api/admin/attendance', {
          action: 'void', attendanceId: existing.id,
        })
      : await postJson<{ attendance: AttendanceRow; deduped: boolean }>('/api/admin/attendance', {
          action: 'add', personId,
        });
    setChipPendingId(null);
    if (!result.ok) {
      showToast(attendanceErrorMessage(result));
      loadAll(); // state may be stale (e.g. someone else already voided it) — resync either way
      return;
    }
    showToast(existing ? 'Removed from today' : 'Checked in');
    loadAll();
  }, [chipPendingId, attendanceByPerson, showToast, loadAll]);

  // ---- Today panel: break-glass kiosk rate-limit reset ----
  // See lib/rate-limit.ts's KIOSK_RATE_LIMITS comment for why these budgets
  // can plausibly trip during a real Wednesday (one shared venue IP for all
  // kiosk traffic) — this is the only recovery path short of waiting out
  // the hour-long window.

  const handleResetRateLimits = useCallback(async () => {
    if (resettingRateLimits) return;
    const confirmed = window.confirm(
      "If the kiosk says \"too many tries,\" this unlocks it right away. Reset kiosk limits now?",
    );
    if (!confirmed) return;
    setResettingRateLimits(true);
    const result = await postJson<{ reset: boolean; cleared: number }>('/api/admin/rate-limits', {
      action: 'reset',
    });
    setResettingRateLimits(false);
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      return;
    }
    showToast('Kiosk limits reset');
  }, [resettingRateLimits, showToast]);

  // ---- Roster panel: create / edit / deactivate / reactivate ----

  const openCreateDialog = useCallback(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    setForm(emptyForm);
    setFormError(null);
    setDialog({ mode: 'create' });
  }, []);

  const openEditDialog = useCallback((person: AdminPerson) => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    setForm({
      fullName: person.fullName,
      industry: person.industry ?? '',
      company: person.company ?? '',
      email: person.email ?? '',
      phone: person.phone ?? '',
      status: editStatusDefault(person.status),
    });
    setFormError(null);
    setDialog({ mode: 'edit', person });
  }, []);

  const closeDialog = useCallback(() => {
    if (saving) return;
    setDialog(null);
    setFormError(null);
    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
  }, [saving]);

  useEffect(() => {
    if (!dialog) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeDialog();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, closeDialog]);

  const updateFields = dialog?.mode === 'edit' ? buildUpdateFields(form, dialog.person) : null;
  const editStatusChanged = dialog?.mode === 'edit' ? form.status !== editStatusDefault(dialog.person.status) : false;
  const saveDisabled = dialog?.mode === 'edit'
    ? Object.keys(updateFields ?? {}).length === 0 && !editStatusChanged
    : form.fullName.trim().length < 2;

  // Edit mode can change status and/or fields in one Save click. Rather than
  // one merged endpoint call, this fires two independent POSTs — changeStatus
  // (lib/roster.ts's own domain fn, with its own failure modes: 400
  // person_deactivated) first, then the field update if anything else
  // changed. Status first means that if the fields POST fails afterward, the
  // person is still left correctly re-classified rather than the failure
  // silently reverting a status change the admin already confirmed via the
  // dialog's Save click.
  const handleSave = useCallback(async () => {
    if (!dialog || saving) return;
    setFormError(null);
    setSaving(true);

    if (dialog.mode === 'create') {
      const result = await postJson<{ person: AdminPerson }>('/api/admin/roster', {
        action: 'create', fields: formToCreateFields(form), status: form.status,
      });
      setSaving(false);
      if (!result.ok) {
        if (result.status === 400) {
          setFormError('Check the highlighted fields and try again.');
        } else {
          setFormError(SAVE_CONNECTION_ERROR);
          showToast(GENERIC_ERROR);
        }
        return;
      }
      setDialog(null);
      showToast('Person added');
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
      loadAll();
      return;
    }

    const statusChanged = form.status !== editStatusDefault(dialog.person.status);
    const fields = buildUpdateFields(form, dialog.person);
    const hasFieldChanges = Object.keys(fields).length > 0;

    // P2-2 fast-follow: parity with the roster row's one-tap "Make member"
    // (handleMakeMember below), which already confirms — editing status via
    // the dialog's Save button was the one status-changing path with no
    // confirmation step at all.
    if (statusChanged) {
      const confirmed = window.confirm(
        `Change ${dialog.person.fullName}'s status to ${STATUS_META[form.status].label}? `
        + "Their check-in history stays intact either way.",
      );
      if (!confirmed) {
        setSaving(false);
        return;
      }
    }

    if (statusChanged) {
      const statusResult = await changeStatusRequest(dialog.person.id, form.status);
      if (!statusResult.ok) {
        setSaving(false);
        if (statusResult.status === 400) {
          setFormError(changeStatusErrorMessage(statusResult));
        } else {
          setFormError(SAVE_CONNECTION_ERROR);
          showToast(GENERIC_ERROR);
        }
        return;
      }
    }

    if (hasFieldChanges) {
      const fieldsResult = await postJson<{ person: AdminPerson }>('/api/admin/roster', {
        action: 'update', personId: dialog.person.id, fields,
      });
      if (!fieldsResult.ok) {
        setSaving(false);
        // P2-2 fast-follow: the status POST above already committed — the
        // person really is reclassified now, even though this second POST
        // failed. Say so explicitly (rather than a plain "check the fields"
        // message that reads as "nothing happened yet") AND resync the
        // background roster/attendance/meetings state now, so the rest of
        // the admin UI behind this still-open dialog reflects the status
        // change immediately instead of waiting for some unrelated future
        // reload.
        const statusNote = statusChanged
          ? ` Status was already changed to ${STATUS_META[form.status].label} — that part saved.`
          : '';
        if (fieldsResult.status === 400) {
          setFormError(`Check the highlighted fields and try again.${statusNote}`);
        } else {
          setFormError(`${SAVE_CONNECTION_ERROR}${statusNote}`);
          showToast(GENERIC_ERROR);
        }
        if (statusChanged) loadAll();
        return;
      }
    }

    setSaving(false);
    setDialog(null);
    showToast('Changes saved');
    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
    loadAll();
  }, [dialog, saving, form, showToast, loadAll]);

  const handleDeactivate = useCallback(async (person: AdminPerson) => {
    if (deactivatingId) return;
    const confirmed = window.confirm(
      `Deactivate ${person.fullName}? They will no longer appear on the roster or kiosk.`,
    );
    if (!confirmed) return;
    setDeactivatingId(person.id);
    const result = await postJson<{ person: AdminPerson }>('/api/admin/roster', {
      action: 'deactivate', personId: person.id,
    });
    setDeactivatingId(null);
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      return;
    }
    showToast(`${person.fullName} deactivated`);
    loadAll();
  }, [deactivatingId, showToast, loadAll]);

  const handleReactivate = useCallback(async (person: AdminPerson) => {
    if (reactivatingId) return;
    setReactivatingId(person.id);
    const result = await postJson<{ person: AdminPerson }>('/api/admin/roster', {
      action: 'reactivate', personId: person.id,
    });
    setReactivatingId(null);
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      return;
    }
    showToast(`${person.fullName} reactivated`);
    loadAll();
  }, [reactivatingId, showToast, loadAll]);

  // One-tap promotion for a visitor row (the "Eric Knight" case: someone
  // everyone already knows is joining, and the edit dialog is overkill for
  // a single-field change). A plain confirm is enough friction for an
  // action that's easy to reason about and, like every other status
  // transition, never destructive — the person keeps their id and full
  // attendance history either way.
  const handleMakeMember = useCallback(async (person: AdminPerson) => {
    if (makingMemberId) return;
    const confirmed = window.confirm(
      `This makes ${person.fullName} a member — they'll appear on the kiosk with everyone else.`,
    );
    if (!confirmed) return;
    setMakingMemberId(person.id);
    const result = await changeStatusRequest(person.id, 'member');
    setMakingMemberId(null);
    if (!result.ok) {
      showToast(changeStatusErrorMessage(result));
      return;
    }
    showToast(`${person.fullName} is now a member`);
    loadAll();
  }, [makingMemberId, showToast, loadAll]);

  // Phase 2 Task 6 admin override for the two-visit kiosk rule — same
  // one-tap-with-confirm shape as handleMakeMember just above. Arms
  // people.allow_extra_visit; lib/checkins.ts's checkIn() consumes it (sets
  // it back false) on that visitor's very next check-in attempt, so this
  // authorizes exactly one more visit, not indefinite bypass.
  const handleAllowExtraVisit = useCallback(async (person: AdminPerson) => {
    if (allowingExtraVisitId) return;
    const confirmed = window.confirm(
      `Let ${person.fullName} check in one more time at the kiosk, past the usual two-visit limit?`,
    );
    if (!confirmed) return;
    setAllowingExtraVisitId(person.id);
    const result = await postJson<{ granted: boolean }>('/api/admin/roster', {
      action: 'allowExtraVisit', personId: person.id,
    });
    setAllowingExtraVisitId(null);
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      return;
    }
    showToast(`${person.fullName} can check in one more time`);
    loadAll();
  }, [allowingExtraVisitId, showToast, loadAll]);

  // ---- Meetings panel: "Show earlier" pagination (Task 8) ----
  // Appends the next page onto the already-loaded list, rather than
  // replacing it — a click on "Show earlier" should only ever grow the
  // list. Deliberately NOT preserved across a loadAll() refresh (mount, or
  // after any mutation elsewhere on the page): loadAll always re-fetches
  // just page 1 via fetchAdminData/applyLoadResult above, so an expanded
  // list collapses back to 26 the next time anything else on the page
  // changes. That's a real trade-off (an admin mid-scroll through history
  // who then checks someone in loses their expanded view) accepted for
  // simplicity — re-fetching N pages' worth after every unrelated mutation
  // would need its own request-id bookkeeping on top of loadRequestIdRef's
  // existing one, for a rarely-used, non-today-affecting view.
  const handleShowEarlierMeetings = useCallback(async () => {
    if (loadingMoreMeetings || !meetingsHasMore) return;
    setLoadingMoreMeetings(true);
    try {
      const res = await fetch(`/api/admin/meetings?offset=${meetings?.length ?? 0}`);
      if (!res.ok) {
        showToast(GENERIC_ERROR);
        return;
      }
      const data = (await res.json()) as MeetingsResponse;
      setMeetings((prev) => [...(prev ?? []), ...data.meetings]);
      setMeetingsHasMore(data.hasMore);
    } catch {
      showToast(GENERIC_ERROR);
    } finally {
      setLoadingMoreMeetings(false);
    }
  }, [loadingMoreMeetings, meetingsHasMore, meetings, showToast]);

  // ---- Emails panel: preview / approve / send now / retry / compile ----

  const handlePreview = useCallback(async (message: EmailMessageRow) => {
    if (previewLoadingId) return;
    previewPreviousFocusRef.current = document.activeElement as HTMLElement | null;
    setPreviewLoadingId(message.id);
    const result = await postJson<{ subject: string; html: string }>('/api/admin/emails', {
      action: 'preview', id: message.id,
    });
    setPreviewLoadingId(null);
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      return;
    }
    setPreviewMessage({ id: message.id, subject: result.data.subject, html: result.data.html });
  }, [previewLoadingId, showToast]);

  const closePreview = useCallback(() => {
    setPreviewMessage(null);
    previewPreviousFocusRef.current?.focus();
    previewPreviousFocusRef.current = null;
  }, []);

  useEffect(() => {
    if (!previewMessage) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closePreview();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewMessage, closePreview]);

  const handleApprove = useCallback(async (message: EmailMessageRow) => {
    if (approvingId) return;
    const confirmed = window.confirm(
      `Approve "${message.label}"? It'll go out on its own once its time comes — you're just clearing it to send.`,
    );
    if (!confirmed) return;
    setApprovingId(message.id);
    const result = await postJson('/api/admin/emails', { action: 'approve', id: message.id });
    setApprovingId(null);
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      return;
    }
    showToast('Approved');
    loadAll();
  }, [approvingId, showToast, loadAll]);

  const handleSendNow = useCallback(async (message: EmailMessageRow) => {
    if (sendingId) return;
    const isRetry = message.state === 'failed';
    const confirmed = window.confirm(
      isRetry
        ? `Try sending "${message.label}" again right now?`
        : `Send "${message.label}" right now, instead of waiting for its scheduled time?`,
    );
    if (!confirmed) return;
    setSendingId(message.id);
    const result = await postJson('/api/admin/emails', { action: 'sendNow', id: message.id });
    setSendingId(null);
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      return;
    }
    showToast(isRetry ? 'Retried' : 'Sent');
    loadAll();
  }, [sendingId, showToast, loadAll]);

  const handleCompile = useCallback(async () => {
    if (compiling || !compileDate) return;
    setCompiling(true);
    const result = await postJson<{ meetingId: string; created: number; skipped: number }>('/api/admin/emails', {
      action: 'compile', meetingDate: compileDate,
    });
    setCompiling(false);
    if (!result.ok) {
      showToast(result.status === 404 ? "No meeting on that date — check the date and try again." : GENERIC_ERROR);
      return;
    }
    showToast(
      result.data.created > 0
        ? `Ready — ${result.data.created} email${result.data.created === 1 ? '' : 's'} compiled`
        : 'Already compiled — nothing new to do',
    );
    setCompileDate('');
    loadAll();
  }, [compiling, compileDate, showToast, loadAll]);

  // ---- Emails panel: settings (approve-mode, send times, recipients) ----

  const handleToggleApproveMode = useCallback(async (next: boolean) => {
    updateSettingsForm((f) => (f ? { ...f, approveMode: next } : f));
    const result = await postJson<{ settings: EmailSettings }>('/api/admin/settings', { approveMode: next });
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      updateSettingsForm((f) => (f ? { ...f, approveMode: !next } : f)); // revert the optimistic flip
      return;
    }
    showToast(next ? 'Approval required before sending' : 'Emails will send by themselves now');
    loadAll();
  }, [updateSettingsForm, showToast, loadAll]);

  const handleSaveEmailSettings = useCallback(async () => {
    if (!settingsForm || savingSettings) return;
    setSettingsError(null);
    setSavingSettings(true);
    const result = await postJson<{ settings: EmailSettings }>('/api/admin/settings', {
      reportSendTime: settingsForm.reportSendTime,
      thankyouSendTime: settingsForm.thankyouSendTime,
      reportRecipients: settingsForm.reportRecipients,
      rsvpNotifyCarey: settingsForm.rsvpNotifyCarey,
      careyEmail: settingsForm.careyEmail,
    });
    setSavingSettings(false);
    if (!result.ok) {
      setSettingsError(result.error ?? SAVE_CONNECTION_ERROR);
      return;
    }
    showToast('Email settings saved');
    loadAll();
  }, [settingsForm, savingSettings, showToast, loadAll]);

  const addRecipient = useCallback(() => {
    const email = recipientInput.trim();
    if (!email) return;
    updateSettingsForm((f) => {
      if (!f) return f;
      if (f.reportRecipients.includes(email)) return f;
      return { ...f, reportRecipients: [...f.reportRecipients, email] };
    });
    setRecipientInput('');
  }, [recipientInput, updateSettingsForm]);

  const removeRecipient = useCallback((email: string) => {
    updateSettingsForm((f) => (f ? { ...f, reportRecipients: f.reportRecipients.filter((e) => e !== email) } : f));
  }, [updateSettingsForm]);

  const toggleRosterRecipient = useCallback((email: string, checked: boolean) => {
    updateSettingsForm((f) => {
      if (!f) return f;
      if (checked) {
        return f.reportRecipients.includes(email) ? f : { ...f, reportRecipients: [...f.reportRecipients, email] };
      }
      return { ...f, reportRecipients: f.reportRecipients.filter((e) => e !== email) };
    });
  }, [updateSettingsForm]);

  // ---- Render ----

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-neutral-100 dark:bg-neutral-950 font-sans">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <Image src="/bni-logo-transparent.png" alt="BNI" width={160} height={90} priority className="h-7 w-auto" />
          <span className="font-display text-lg font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
            Wheeling · Admin
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
          <a
            href="/kiosk"
            className="min-h-[48px] inline-flex items-center rounded-full border border-neutral-300 px-4 font-medium text-neutral-700 hover:bg-white dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            View kiosk
          </a>
          <span>{adminEmail}</span>
          {meetingDate && (
            <span className="rounded-full bg-white px-3.5 py-1.5 font-medium text-neutral-600 shadow-sm dark:bg-neutral-900 dark:text-neutral-300">
              {formatMeetingDate(meetingDate)}
            </span>
          )}
        </div>
      </header>

      <main className="flex-1 px-4 pb-12 sm:px-8">
        <div className="mx-auto max-w-5xl">
          {loadError && (
            <div className="mt-8 rounded-2xl bg-white p-8 text-center text-neutral-500 shadow-sm dark:bg-neutral-900 dark:text-neutral-400">
              Can&apos;t reach the server — check the connection
            </div>
          )}

          {!loadError && (
            people === null || attendance === null || meetings === null
            || emailMessages === null || settingsForm === null
          ) && (
            <div className="mt-8 rounded-2xl bg-white p-8 text-center text-neutral-500 shadow-sm dark:bg-neutral-900 dark:text-neutral-400">
              Loading…
            </div>
          )}

          {!loadError && people !== null && attendance !== null && meetings !== null
            && emailMessages !== null && settingsForm !== null && (
            <>
              <TodayPanel
                people={activePeople}
                attendanceByPerson={attendanceByPerson}
                pendingId={chipPendingId}
                onToggle={toggleAttendance}
                onResetRateLimits={handleResetRateLimits}
                resettingRateLimits={resettingRateLimits}
              />
              <RosterPanel
                people={people}
                showDeactivated={showDeactivated}
                onToggleShowDeactivated={setShowDeactivated}
                deactivatingId={deactivatingId}
                reactivatingId={reactivatingId}
                makingMemberId={makingMemberId}
                allowingExtraVisitId={allowingExtraVisitId}
                onAdd={openCreateDialog}
                onEdit={openEditDialog}
                onDeactivate={handleDeactivate}
                onReactivate={handleReactivate}
                onMakeMember={handleMakeMember}
                onAllowExtraVisit={handleAllowExtraVisit}
              />
              <MeetingsPanel
                meetings={meetings}
                todayDate={meetingDate}
                hasMore={meetingsHasMore}
                loadingMore={loadingMoreMeetings}
                onShowEarlier={handleShowEarlierMeetings}
              />
              <EmailsSection
                messages={emailMessages}
                safeMode={emailSafeMode}
                previewLoadingId={previewLoadingId}
                approvingId={approvingId}
                sendingId={sendingId}
                onPreview={handlePreview}
                onApprove={handleApprove}
                onSendNow={handleSendNow}
                compileDate={compileDate}
                onCompileDateChange={setCompileDate}
                compiling={compiling}
                onCompile={handleCompile}
                settingsForm={settingsForm}
                onToggleApproveMode={handleToggleApproveMode}
                onSettingsFormChange={updateSettingsForm}
                recipientInput={recipientInput}
                onRecipientInputChange={setRecipientInput}
                onAddRecipient={addRecipient}
                onRemoveRecipient={removeRecipient}
                onToggleRosterRecipient={toggleRosterRecipient}
                rosterWithEmail={people.filter((p) => p.email !== null && p.deactivatedAt === null)}
                savingSettings={savingSettings}
                settingsError={settingsError}
                onSaveSettings={handleSaveEmailSettings}
              />
            </>
          )}
        </div>
      </main>

      {dialog && (
        <PersonDialog
          mode={dialog.mode}
          form={form}
          setForm={setForm}
          error={formError}
          saving={saving}
          saveDisabled={saveDisabled}
          onSave={handleSave}
          onClose={closeDialog}
        />
      )}

      {previewMessage && (
        <EmailPreviewDialog
          subject={previewMessage.subject}
          html={previewMessage.html}
          onClose={closePreview}
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 flex justify-center px-4">
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto rounded-full bg-neutral-900 px-5 py-3 text-sm font-medium text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
          >
            {toast.text}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Today panel ----------------------------------------------------------

function TodayPanel({
  people, attendanceByPerson, pendingId, onToggle, onResetRateLimits, resettingRateLimits,
}: {
  people: AdminPerson[];
  attendanceByPerson: Map<string, AttendanceRow>;
  pendingId: string | null;
  onToggle: (personId: string) => void;
  onResetRateLimits: () => void;
  resettingRateLimits: boolean;
}) {
  const sorted = useMemo(
    () => [...people].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [people],
  );

  return (
    <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            Today · {attendanceByPerson.size} checked in
          </h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Tap a person to add or void today&apos;s attendance
          </p>
        </div>
        {/* Quiet by design — this is a break-glass control for a rare kiosk
            hiccup, not a routine action, so it shouldn't compete visually
            with the panel's normal check-in taps. */}
        <Button variant="ghost" tone="neutral" size="md" onClick={onResetRateLimits} disabled={resettingRateLimits}>
          {resettingRateLimits ? 'Resetting…' : 'Reset kiosk limits'}
        </Button>
      </div>

      {sorted.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-400 dark:text-neutral-500">No one on the roster yet.</p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
          {sorted.map((p) => (
            <TodayChip
              key={p.id}
              person={p}
              attendanceRow={attendanceByPerson.get(p.id) ?? null}
              pending={pendingId === p.id}
              onTap={() => onToggle(p.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TodayChip({
  person, attendanceRow, pending, onTap,
}: {
  person: AdminPerson;
  attendanceRow: AttendanceRow | null;
  pending: boolean;
  onTap: () => void;
}) {
  const checkedIn = attendanceRow !== null;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onTap}
      className={`min-h-[52px] rounded-2xl border px-4 py-2.5 text-left text-sm font-medium transition active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 ${
        checkedIn
          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
          : 'border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300'
      }`}
    >
      {person.fullName}
      {checkedIn && attendanceRow.kind === 'visitor' && attendanceRow.visitNumber != null && (
        <span className="ml-1 font-normal opacity-80">· visit {attendanceRow.visitNumber}</span>
      )}
    </button>
  );
}

// ---- Roster panel ----------------------------------------------------------

function RosterPanel({
  people, showDeactivated, onToggleShowDeactivated, deactivatingId, reactivatingId, makingMemberId,
  allowingExtraVisitId,
  onAdd, onEdit, onDeactivate, onReactivate, onMakeMember, onAllowExtraVisit,
}: {
  people: AdminPerson[];
  showDeactivated: boolean;
  onToggleShowDeactivated: (v: boolean) => void;
  deactivatingId: string | null;
  reactivatingId: string | null;
  makingMemberId: string | null;
  allowingExtraVisitId: string | null;
  onAdd: () => void;
  onEdit: (person: AdminPerson) => void;
  onDeactivate: (person: AdminPerson) => void;
  onReactivate: (person: AdminPerson) => void;
  onMakeMember: (person: AdminPerson) => void;
  onAllowExtraVisit: (person: AdminPerson) => void;
}) {
  const sorted = useMemo(
    () => [...people].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [people],
  );

  return (
    <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Roster</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Everyone in the chapter — members, leadership, and visitors. Add someone, edit their details, or change their status here.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={showDeactivated}
              onChange={(e) => onToggleShowDeactivated(e.target.checked)}
              className="h-4 w-4 rounded border-neutral-300 dark:border-neutral-600"
            />
            Show deactivated
          </label>
          <Button variant="primary" onClick={onAdd}>
            + Add person
          </Button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-400 dark:text-neutral-500">No one on the roster yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                <th className="px-3 pb-2">Name</th>
                <th className="px-3 pb-2">Industry</th>
                <th className="px-3 pb-2">Email</th>
                <th className="px-3 pb-2">Status</th>
                <th className="px-3 pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <RosterRow
                  key={p.id}
                  person={p}
                  deactivating={deactivatingId === p.id}
                  reactivating={reactivatingId === p.id}
                  makingMember={makingMemberId === p.id}
                  allowingExtraVisit={allowingExtraVisitId === p.id}
                  onEdit={() => onEdit(p)}
                  onDeactivate={() => onDeactivate(p)}
                  onReactivate={() => onReactivate(p)}
                  onMakeMember={() => onMakeMember(p)}
                  onAllowExtraVisit={() => onAllowExtraVisit(p)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RosterRow({
  person, deactivating, reactivating, makingMember, allowingExtraVisit,
  onEdit, onDeactivate, onReactivate, onMakeMember, onAllowExtraVisit,
}: {
  person: AdminPerson;
  deactivating: boolean;
  reactivating: boolean;
  makingMember: boolean;
  allowingExtraVisit: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onMakeMember: () => void;
  onAllowExtraVisit: () => void;
}) {
  const meta = STATUS_META[person.status];
  const deactivated = person.deactivatedAt !== null;
  // Phase 2 Task 6: only a visitor already at (or past) the two-visit
  // limit ever needs this — showing it for a fresh first-time visitor would
  // just be noise on every single row.
  const atVisitLimit = person.status === 'visitor' && person.visitCount >= 2;
  return (
    <tr className={`border-t border-neutral-100 dark:border-neutral-800 ${deactivated ? 'opacity-60' : ''}`}>
      <td className="px-3 py-3 md:py-4 text-sm font-medium text-neutral-900 dark:text-neutral-50">{person.fullName}</td>
      <td className="px-3 py-3 md:py-4 text-sm text-neutral-600 dark:text-neutral-400">{person.industry ?? '—'}</td>
      <td className="px-3 py-3 md:py-4 text-sm text-neutral-600 dark:text-neutral-400">
        {person.email ?? '—'}
        {person.emailBounced && (
          // Phase 2 Task 7: this visitor's thank-you email bounced — a
          // mistyped address is visible here Thursday, not discovered in
          // month three (spec §7). Email-match heuristic computed
          // server-side (app/api/admin/roster/route.ts's GET), so it stays
          // accurate as roster emails change.
          <span
            title="A thank-you email to this address bounced"
            className="ml-2 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300"
          >
            Email bounced
          </span>
        )}
      </td>
      <td className="px-3 py-3 md:py-4">
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${meta.className}`}>
          {meta.label}
        </span>
      </td>
      <td className="px-3 py-3 md:py-4 text-right text-sm">
        {deactivated ? (
          <Button variant="ghost" tone="neutral" size="md" className="!px-0 !py-0" onClick={onReactivate} disabled={reactivating}>
            {reactivating ? 'Reactivating…' : 'Reactivate'}
          </Button>
        ) : (
          <>
            {person.status === 'visitor' && (
              <Button
                variant="ghost"
                tone="neutral"
                size="md"
                className="mr-4 !px-0 !py-0"
                onClick={onMakeMember}
                disabled={makingMember}
              >
                {makingMember ? 'Making member…' : 'Make member'}
              </Button>
            )}
            {atVisitLimit && (
              person.allowExtraVisit ? (
                // Already armed — quiet static text, not a repeatable
                // button, since a second click would be a no-op that just
                // re-confirms the same state (see grantExtraVisit).
                <span className="mr-4 text-xs text-neutral-400 dark:text-neutral-500">
                  Extra visit allowed next time
                </span>
              ) : (
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="md"
                  className="mr-4 !px-0 !py-0"
                  onClick={onAllowExtraVisit}
                  disabled={allowingExtraVisit}
                >
                  {allowingExtraVisit ? 'Allowing…' : 'Allow another visit'}
                </Button>
              )
            )}
            <button
              type="button"
              onClick={onEdit}
              disabled={deactivating}
              className="mr-4 inline-flex min-h-[48px] items-center font-medium text-neutral-600 transition hover:underline disabled:opacity-50 dark:text-neutral-300"
            >
              Edit
            </button>
            <Button variant="ghost" tone="brand" size="md" className="!px-0 !py-0" onClick={onDeactivate} disabled={deactivating}>
              {deactivating ? 'Deactivating…' : 'Deactivate'}
            </Button>
          </>
        )}
      </td>
    </tr>
  );
}

// ---- Meetings panel (option B "Meeting list") ------------------------------

// 1st / 2nd / 3rd / 4th… — used for the visitor roll's "(Nth visit)" markers
// inside an expanded meeting row.
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" aria-hidden="true"
      className={`h-4 w-4 flex-none text-neutral-400 transition-transform duration-150 dark:text-neutral-500 ${
        expanded ? 'rotate-90' : ''
      }`}
    >
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MeetingsPanel({
  meetings, todayDate, hasMore, loadingMore, onShowEarlier,
}: {
  meetings: AdminMeeting[];
  todayDate: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onShowEarlier: () => void;
}) {
  // Local, ephemeral UI state (which rows are expanded) — deliberately not
  // lifted to AdminClient: nothing else needs it, and it's fine for it to
  // reset if this component ever unmounts. It does, however, survive the
  // refetch that follows every attendance mutation (loadAll re-runs, but
  // MeetingsPanel itself stays mounted and just receives a new `meetings`
  // prop), so expanding a row and then toggling someone's check-in in the
  // Today panel above doesn't collapse it back.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  return (
    <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Meetings</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Last {meetings.length} meeting{meetings.length === 1 ? '' : 's'}, most recent first — tap a row for the roll
      </p>

      {meetings.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-400 dark:text-neutral-500">No meetings recorded yet.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-2.5">
          {meetings.map((m) => (
            <MeetingRow
              key={m.id}
              meeting={m}
              isToday={m.meetingDate === todayDate}
              expanded={expandedIds.has(m.id)}
              onToggle={() => toggle(m.id)}
            />
          ))}
        </div>
      )}

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={onShowEarlier} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show earlier'}
          </Button>
        </div>
      )}
    </section>
  );
}

function MeetingRow({
  meeting, isToday, expanded, onToggle,
}: {
  meeting: AdminMeeting;
  isToday: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const members = useMemo(() => meeting.attendees.filter((a) => a.kind === 'member'), [meeting.attendees]);
  const leadership = useMemo(() => meeting.attendees.filter((a) => a.kind === 'leadership'), [meeting.attendees]);
  const visitors = useMemo(() => meeting.attendees.filter((a) => a.kind === 'visitor'), [meeting.attendees]);

  return (
    <div className="rounded-xl border border-neutral-100 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-3 text-left transition active:scale-[0.99]"
      >
        <span className="flex items-center gap-2.5">
          <ChevronIcon expanded={expanded} />
          <span className="font-medium text-neutral-900 dark:text-neutral-50">
            {isToday ? 'Today' : formatMeetingDate(meeting.meetingDate)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="text-sm text-neutral-600 dark:text-neutral-300">{meeting.total} attended</span>
          {meeting.visitorCount > 0 ? (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              {meeting.visitorCount} visitor{meeting.visitorCount === 1 ? '' : 's'}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              no visitors
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-1.5 border-t border-neutral-100 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
          {members.length === 0 && leadership.length === 0 && visitors.length === 0 && (
            <p className="text-neutral-400 dark:text-neutral-500">No attendance recorded.</p>
          )}
          {members.length > 0 && (
            <p>
              <span className="font-medium text-neutral-500 dark:text-neutral-400">Members: </span>
              {members.map((a) => a.fullName).join(', ')}
            </p>
          )}
          {leadership.length > 0 && (
            <p>
              <span className="font-medium text-neutral-500 dark:text-neutral-400">Leadership: </span>
              {leadership.map((a) => a.fullName).join(', ')}
            </p>
          )}
          {visitors.length > 0 && (
            <p>
              <span className="font-medium text-neutral-500 dark:text-neutral-400">Visitors: </span>
              {visitors
                .map((a) => (a.visitNumber != null ? `${a.fullName} (${ordinal(a.visitNumber)} visit)` : a.fullName))
                .join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Emails section (Phase 2 Task 5) ---------------------------------------

// Chicago clock time regardless of the admin's own device timezone — same
// reasoning as formatMeetingDate's fixed 'UTC' trick above, just for a
// time-of-day instead of a calendar date: the settings' send times are
// always Chicago-local, and a chip reading "Scheduled 5:30 PM" needs to mean
// 5:30 PM Chicago time no matter where the admin happens to be sitting.
function formatClockTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

function formatExportTimestamp(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

const EMAIL_STATE_META: Record<EmailState, { label: (m: EmailMessageRow) => string; className: string }> = {
  draft: {
    label: () => 'Draft',
    className: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
  },
  awaiting_approval: {
    label: () => 'Waiting for approval',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  },
  approved: {
    label: () => 'Approved',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  },
  scheduled: {
    label: (m) => (m.scheduledFor ? `Scheduled ${formatClockTime(m.scheduledFor)}` : 'Scheduled'),
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  },
  sending: {
    label: () => 'Sending…',
    className: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
  },
  sent: {
    label: (m) => (m.sentAt ? `Sent ${formatClockTime(m.sentAt)}` : 'Sent'),
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  },
  failed: {
    label: () => 'Failed',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  },
};

function EmailStateChip({ message }: { message: EmailMessageRow }) {
  const meta = EMAIL_STATE_META[message.state];
  return (
    <span className={`inline-flex flex-none items-center rounded-full px-2.5 py-1 text-xs font-medium ${meta.className}`}>
      {meta.label(message)}
    </span>
  );
}

// Phase 2 Task 7: a second, independent chip reporting what Resend's
// webhook has told us actually happened to the message AFTER Resend
// accepted it — "Sent" (the state chip above) only means Resend took the
// request, not that a mailbox ever received it (spec §7). Kept simple per
// the plan: the chip's time is the message's own sentAt, not a second query
// for the matching email_events row's occurredAt — good enough for "did
// this land," not meant to be a delivery-events timeline.
const DELIVERY_STATUS_META: Record<DeliveryStatus, { label: string; className: string }> = {
  sent: { label: 'Sent', className: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300' },
  delayed: { label: 'Delayed', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  delivered: {
    label: 'Delivered',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  },
  bounced: { label: 'Bounced', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  complained: { label: 'Complained', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  failed: { label: 'Delivery failed', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
};

function DeliveryStatusChip({ message }: { message: EmailMessageRow }) {
  // A plain 'sent' delivery status is exactly what the state chip already
  // says ("Sent 5:02 PM") — showing it a second time here would just be
  // noise, so this chip only earns its place once the webhook has told us
  // something the state chip doesn't already know.
  if (!message.deliveryStatus || message.deliveryStatus === 'sent') return null;
  const meta = DELIVERY_STATUS_META[message.deliveryStatus];
  const time = message.sentAt ? ` ${formatClockTime(message.sentAt)}` : '';
  return (
    <span className={`inline-flex flex-none items-center rounded-full px-2.5 py-1 text-xs font-medium ${meta.className}`}>
      {meta.label}{time}
    </span>
  );
}

// The type ordering rows appear in within a meeting group — report first
// (the "big picture" email), then thank-yous, then the internal
// approval-notice housekeeping message last. rsvp_notice/weekly_export never
// share a group with a meeting-scoped type (see groupEmailMessages below),
// so their own relative order here doesn't matter — included for
// completeness/exhaustiveness of the Record.
const TYPE_ORDER: Record<EmailType, number> = {
  leadership_report: 0, visitor_thankyou: 1, approval_notice: 2, weekly_export: 3, rsvp_notice: 4,
};

// P2-6 carry-in (Task 8): rsvp_notice rows (meetingId always null — an RSVP
// token outlives any single meeting's compile) were previously invisible in
// this admin view entirely, which broke the failed-rows-recovery invariant
// (app/api/admin/emails' GET now includes them; this is the client half —
// giving them somewhere to render). They get their OWN pseudo-group
// ('notifications'), never merged with the pre-existing 'exports'
// pseudo-group weekly_export rows use — the two types have nothing to do
// with each other and merging them under one ambiguous "Weekly exports"
// label would bury one inside the other.
type PseudoGroupKind = 'meeting' | 'notifications' | 'exports';
type MeetingEmailGroup = {
  meetingId: string | null; meetingDate: string | null; kind: PseudoGroupKind; messages: EmailMessageRow[];
};

function pseudoGroupKeyFor(m: EmailMessageRow): string {
  if (m.meetingId) return m.meetingId;
  return m.type === 'rsvp_notice' ? 'notifications' : 'exports';
}

export function groupEmailMessages(messages: EmailMessageRow[]): MeetingEmailGroup[] {
  const byKey = new Map<string, MeetingEmailGroup>();
  for (const m of messages) {
    const key = pseudoGroupKeyFor(m);
    let group = byKey.get(key);
    if (!group) {
      const kind: PseudoGroupKind = m.meetingId ? 'meeting' : (key === 'notifications' ? 'notifications' : 'exports');
      group = { meetingId: m.meetingId, meetingDate: m.meetingDate, kind, messages: [] };
      byKey.set(key, group);
    }
    group.messages.push(m);
  }
  for (const group of byKey.values()) {
    group.messages.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.label.localeCompare(b.label));
  }
  // Real meetings sort most-recent-first; the two non-meeting pseudo-groups
  // always sort after every real meeting (neither is "a week," so neither
  // competes with them) — notifications before exports, since a pending
  // RSVP notice is closer to "needs attention now" than a backup file.
  const kindRank: Record<PseudoGroupKind, number> = { meeting: 0, notifications: 1, exports: 2 };
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.kind !== b.kind) return kindRank[a.kind] - kindRank[b.kind];
    if (a.kind !== 'meeting') return 0; // stable — only one of each pseudo-group ever exists
    return (b.meetingDate ?? '').localeCompare(a.meetingDate ?? '');
  });
}

const SEND_NOW_STATES: EmailState[] = ['draft', 'awaiting_approval', 'scheduled', 'failed'];

function EmailsSection({
  messages, safeMode, previewLoadingId, approvingId, sendingId, onPreview, onApprove, onSendNow,
  compileDate, onCompileDateChange, compiling, onCompile,
  settingsForm, onToggleApproveMode, onSettingsFormChange,
  recipientInput, onRecipientInputChange, onAddRecipient, onRemoveRecipient, onToggleRosterRecipient,
  rosterWithEmail, savingSettings, settingsError, onSaveSettings,
}: {
  messages: EmailMessageRow[];
  safeMode: boolean;
  previewLoadingId: string | null;
  approvingId: string | null;
  sendingId: string | null;
  onPreview: (m: EmailMessageRow) => void;
  onApprove: (m: EmailMessageRow) => void;
  onSendNow: (m: EmailMessageRow) => void;
  compileDate: string;
  onCompileDateChange: (v: string) => void;
  compiling: boolean;
  onCompile: () => void;
  settingsForm: EmailSettings;
  onToggleApproveMode: (next: boolean) => void;
  onSettingsFormChange: (updater: (f: EmailSettings | null) => EmailSettings | null) => void;
  recipientInput: string;
  onRecipientInputChange: (v: string) => void;
  onAddRecipient: () => void;
  onRemoveRecipient: (email: string) => void;
  onToggleRosterRecipient: (email: string, checked: boolean) => void;
  rosterWithEmail: AdminPerson[];
  savingSettings: boolean;
  settingsError: string | null;
  onSaveSettings: () => void;
}) {
  const groups = useMemo(() => groupEmailMessages(messages), [messages]);
  const failedCount = useMemo(() => messages.filter((m) => m.state === 'failed').length, [messages]);
  const latestWeeklyExport = useMemo(
    () => messages
      .filter((m) => m.type === 'weekly_export' && m.sentAt)
      .sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''))[0] ?? null,
    [messages],
  );

  return (
    <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Emails</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Visitor thank-yous and the weekly leadership report &mdash; preview them, approve them, or send them yourself.
      </p>

      {safeMode && (
        <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          Test mode is on &mdash; every email is redirected to your inbox with a [SAFE&rarr;&hellip;] label. Nothing reaches real visitors.
        </div>
      )}

      {failedCount > 0 && (
        <div className={`mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium dark:bg-red-950/40 ${RED_TEXT_CLASS}`}>
          {failedCount === 1 ? '1 email failed to send — see below.' : `${failedCount} emails failed to send — see below.`}
        </div>
      )}

      {groups.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-400 dark:text-neutral-500">No emails yet.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.meetingId ?? group.kind}>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {group.kind === 'meeting' && group.meetingDate ? formatMeetingDate(group.meetingDate) : null}
                {group.kind === 'notifications' ? 'Notifications' : null}
                {group.kind === 'exports' ? 'Weekly exports' : null}
              </p>
              <div className="flex flex-col gap-2">
                {group.messages.map((m) => (
                  <EmailRow
                    key={m.id}
                    message={m}
                    previewLoading={previewLoadingId === m.id}
                    approving={approvingId === m.id}
                    sending={sendingId === m.id}
                    onPreview={() => onPreview(m)}
                    onApprove={() => onApprove(m)}
                    onSendNow={() => onSendNow(m)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-neutral-200 px-4 py-3 text-sm dark:border-neutral-700">
        <span className="text-neutral-500 dark:text-neutral-400">
          Special meeting on a different day? Get its emails ready:
        </span>
        <input
          type="date"
          value={compileDate}
          onChange={(e) => onCompileDateChange(e.target.value)}
          className={`${ADMIN_INPUT_CLASS} w-auto`}
        />
        <Button variant="ghost" tone="neutral" size="md" onClick={onCompile} disabled={compiling || !compileDate}>
          {compiling ? 'Getting them ready…' : 'Get emails ready'}
        </Button>
      </div>

      {/* ---- Email settings card ---- */}
      <div className="mt-6 border-t border-neutral-100 pt-6 dark:border-neutral-800">
        <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">Email settings</h3>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Controls when the Wednesday emails go out, and who sees the leadership report.
        </p>

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl bg-neutral-50 p-4 dark:bg-neutral-800/50">
          <input
            type="checkbox"
            checked={settingsForm.approveMode}
            onChange={(e) => onToggleApproveMode(e.target.checked)}
            className="mt-0.5 h-5 w-5 flex-none rounded border-neutral-300 dark:border-neutral-600"
          />
          <span>
            <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">
              Approve before sending
            </span>
            <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
              These send by themselves on Wednesdays. You approve them first while this switch is on.
            </span>
          </span>
        </label>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <DialogField label="Visitor thank-you time">
            <input
              type="time"
              min="16:45"
              max="19:45"
              value={settingsForm.thankyouSendTime}
              onChange={(e) => onSettingsFormChange((f) => (f ? { ...f, thankyouSendTime: e.target.value } : f))}
              className={ADMIN_INPUT_CLASS}
            />
            <span className="mt-1 block text-xs text-neutral-400 dark:text-neutral-500">
              Between 4:45 and 7:45 PM — emails go out at the next quarter-hour.
            </span>
          </DialogField>
          <DialogField label="Leadership report time">
            <input
              type="time"
              min="16:45"
              max="19:45"
              value={settingsForm.reportSendTime}
              onChange={(e) => onSettingsFormChange((f) => (f ? { ...f, reportSendTime: e.target.value } : f))}
              className={ADMIN_INPUT_CLASS}
            />
            <span className="mt-1 block text-xs text-neutral-400 dark:text-neutral-500">
              Between 4:45 and 7:45 PM — emails go out at the next quarter-hour.
            </span>
          </DialogField>
        </div>

        <div className="mt-4">
          <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Who gets the weekly report</p>
          <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
            Jason always gets a copy too, even if this list is empty.
          </p>

          {settingsForm.reportRecipients.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {settingsForm.reportRecipients.map((email) => (
                <span
                  key={email}
                  className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 py-1 pl-3 pr-1.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  {email}
                  <button
                    type="button"
                    onClick={() => onRemoveRecipient(email)}
                    aria-label={`Remove ${email}`}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="mt-2 flex gap-2">
            <input
              type="email"
              value={recipientInput}
              onChange={(e) => onRecipientInputChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAddRecipient(); } }}
              placeholder="name@example.com"
              className={ADMIN_INPUT_CLASS}
            />
            <Button type="button" variant="secondary" onClick={onAddRecipient}>Add</Button>
          </div>

          {rosterWithEmail.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-neutral-400 dark:text-neutral-500">Or pick from the roster:</p>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {rosterWithEmail.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                    <input
                      type="checkbox"
                      checked={settingsForm.reportRecipients.includes(p.email!)}
                      onChange={(e) => onToggleRosterRecipient(p.email!, e.target.checked)}
                      className="h-4 w-4 rounded border-neutral-300 dark:border-neutral-600"
                    />
                    {p.fullName} <span className="text-neutral-400 dark:text-neutral-500">({p.email})</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* P2-6 carry-in: RSVP owner-notification's optional second
            recipient. The toggle is disabled (not just unchecked) until an
            address is on file — turning it on with nothing to notify would
            silently do nothing, so the control itself refuses to offer
            that state rather than relying on the save button's error to
            catch it after the fact. */}
        <div className="mt-4">
          <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">When a visitor RSVPs</p>
          <label
            className={`mt-2 flex items-start gap-3 rounded-xl bg-neutral-50 p-4 dark:bg-neutral-800/50 ${
              settingsForm.careyEmail ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
            }`}
          >
            <input
              type="checkbox"
              checked={settingsForm.rsvpNotifyCarey}
              disabled={!settingsForm.careyEmail}
              onChange={(e) => onSettingsFormChange((f) => (f ? { ...f, rsvpNotifyCarey: e.target.checked } : f))}
              className="mt-0.5 h-5 w-5 flex-none rounded border-neutral-300 dark:border-neutral-600"
            />
            <span>
              <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">
                Also notify Carey when a visitor RSVPs
              </span>
              <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                {settingsForm.careyEmail ? "Jason always gets this — this adds Carey too." : "Add Carey's email first."}
              </span>
            </span>
          </label>
          <div className="mt-2">
            <DialogField label="Carey's email">
              <input
                type="email"
                value={settingsForm.careyEmail ?? ''}
                onChange={(e) => onSettingsFormChange((f) => {
                  if (!f) return f;
                  const trimmed = e.target.value.trim();
                  const careyEmail = trimmed === '' ? null : e.target.value;
                  // Clearing the address also switches the toggle back off
                  // — otherwise it'd sit disabled-but-checked, a confusing
                  // state that would only surface as an error at save time.
                  return { ...f, careyEmail, rsvpNotifyCarey: careyEmail ? f.rsvpNotifyCarey : false };
                })}
                placeholder="carey@example.com"
                className={ADMIN_INPUT_CLASS}
              />
            </DialogField>
          </div>
        </div>

        {settingsError && (
          <div className={`mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm dark:bg-red-950/40 ${RED_TEXT_CLASS}`}>
            {settingsError}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button variant="primary" onClick={onSaveSettings} disabled={savingSettings}>
            {savingSettings ? 'Saving…' : 'Save email settings'}
          </Button>
        </div>

        <div className="mt-6 border-t border-neutral-100 pt-4 text-sm dark:border-neutral-800">
          <p className="font-medium text-neutral-700 dark:text-neutral-300">Weekly backup export</p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {latestWeeklyExport?.sentAt
              ? `Last sent ${formatExportTimestamp(latestWeeklyExport.sentAt)}. `
              : 'No export sent yet. '}
            Sunday exports arrive in your inbox.
          </p>
        </div>
      </div>
    </section>
  );
}

function EmailRow({
  message, previewLoading, approving, sending, onPreview, onApprove, onSendNow,
}: {
  message: EmailMessageRow;
  previewLoading: boolean;
  approving: boolean;
  sending: boolean;
  onPreview: () => void;
  onApprove: () => void;
  onSendNow: () => void;
}) {
  const canSendNow = SEND_NOW_STATES.includes(message.state);
  const isRetry = message.state === 'failed';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-100 px-4 py-3 dark:border-neutral-800">
      <div className="min-w-0">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{message.label}</p>
        <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
          {message.subject} &middot; {message.recipientsCount} recipient{message.recipientsCount === 1 ? '' : 's'}
        </p>
        {message.state === 'failed' && message.error && (
          <p className={`mt-1 text-xs ${RED_TEXT_CLASS}`}>{message.error}</p>
        )}
      </div>
      <div className="flex flex-none items-center gap-3">
        <EmailStateChip message={message} />
        <DeliveryStatusChip message={message} />
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={onPreview}
            disabled={previewLoading}
            className="inline-flex min-h-[48px] items-center font-medium text-neutral-600 transition hover:underline disabled:opacity-50 dark:text-neutral-300"
          >
            {previewLoading ? 'Loading…' : 'Preview'}
          </button>
          {message.state === 'awaiting_approval' && (
            <Button variant="ghost" tone="neutral" size="md" className="!px-0 !py-0" onClick={onApprove} disabled={approving}>
              {approving ? 'Approving…' : 'Approve'}
            </Button>
          )}
          {canSendNow && (
            <Button variant="ghost" tone="brand" size="md" className="!px-0 !py-0" onClick={onSendNow} disabled={sending}>
              {sending ? (isRetry ? 'Retrying…' : 'Sending…') : (isRetry ? 'Retry' : 'Send now')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Reuses PersonDialog's own focus-trap/Escape/restore-focus conventions
// (Tab-trap scoped to this dialog's container; Escape + focus-restore are
// handled by the parent, same split as PersonDialog/AdminClient).
function EmailPreviewDialog({ subject, html, onClose }: { subject: string; html: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = dialogRef.current;
    if (!container) return;

    function focusableElements(): HTMLElement[] {
      return Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusable = focusableElements();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container!.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container!.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-preview-title"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-lg dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-6 py-4 dark:border-neutral-800">
          <div className="min-w-0">
            <h2 id="email-preview-title" className="truncate text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              {subject}
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">Preview only &mdash; nothing sends from here.</p>
          </div>
          <Button type="button" variant="secondary" size="md" onClick={onClose} autoFocus>
            Close
          </Button>
        </div>
        <iframe
          title="Email preview"
          sandbox=""
          srcDoc={html}
          className="min-h-[60vh] w-full flex-1 bg-white"
        />
      </div>
    </div>
  );
}

// ---- Person dialog (create / edit) -----------------------------------------

function PersonDialog({
  mode, form, setForm, error, saving, saveDisabled, onSave, onClose,
}: {
  mode: 'create' | 'edit';
  form: PersonFormState;
  setForm: (updater: (f: PersonFormState) => PersonFormState) => void;
  error: string | null;
  saving: boolean;
  saveDisabled: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap: Tab/Shift+Tab cycle between the dialog's first and last
  // focusable elements instead of escaping into the page behind the overlay.
  // No library — just the standard "collect focusables, wrap at the ends"
  // pattern, scoped to this dialog's own container so it mounts/unmounts
  // with it automatically.
  useEffect(() => {
    const container = dialogRef.current;
    if (!container) return;

    function focusableElements(): HTMLElement[] {
      return Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusable = focusableElements();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container!.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container!.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-dialog-title"
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-lg dark:bg-neutral-900"
      >
        <h2 id="person-dialog-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
          {mode === 'create' ? 'Add person' : 'Edit person'}
        </h2>

        {error && (
          <div className={`mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm dark:bg-red-950/40 ${RED_TEXT_CLASS}`}>
            {error}
          </div>
        )}

        <form className="mt-4 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
          <DialogField label="Full name">
            <input
              type="text"
              required
              minLength={2}
              autoFocus
              value={form.fullName}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
              className={ADMIN_INPUT_CLASS}
            />
          </DialogField>
          <DialogField label="Industry">
            <input
              type="text"
              value={form.industry}
              onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))}
              className={ADMIN_INPUT_CLASS}
            />
          </DialogField>
          <DialogField label="Company">
            <input
              type="text"
              value={form.company}
              onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
              className={ADMIN_INPUT_CLASS}
            />
          </DialogField>
          <DialogField label="Email">
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className={ADMIN_INPUT_CLASS}
            />
          </DialogField>
          <DialogField label="Phone">
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className={ADMIN_INPUT_CLASS}
            />
          </DialogField>
          <DialogField label="Status">
            <select
              value={form.status}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as CreateStatus }))}
              className={ADMIN_INPUT_CLASS}
            >
              <option value="member">Member</option>
              <option value="leadership">Leadership</option>
              <option value="visitor">Visitor</option>
            </select>
            {mode === 'edit' && (
              <span className="mt-1 block text-xs text-neutral-400 dark:text-neutral-500">
                Changing this moves them between the roster groups — their check-in history stays intact.
              </span>
            )}
          </DialogField>

          <div className="mt-2 flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving || saveDisabled}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DialogField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</span>
      {children}
    </label>
  );
}
