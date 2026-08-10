'use client';

import { useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from 'react';

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
  | { ok: true; people: AdminPerson[]; attendance: AttendanceRow[]; meetingDate: string }
  | { ok: false };

const GENERIC_ERROR = 'Something went wrong — try again.';
const SAVE_CONNECTION_ERROR = "Couldn't save — check the connection and try again.";
const TOAST_MS = 2_500;

// Brand accent. Kept as a single JS constant for reference, but Tailwind's
// arbitrary-value classes must stay literal strings for its build-time
// scanner — see the equivalent comment in app/kiosk/kiosk-client.tsx. Any
// usage that needs to react to component state goes through inline `style`
// referencing this constant; static, always-red usages keep the literal
// Tailwind class. This is only safe for BACKGROUND red (white text on top) —
// it passes contrast in both themes.
const BRAND_RED = '#CF2030';

// #CF2030 as TEXT (not background) fails WCAG on dark surfaces: measured
// ~3.3:1 against neutral-900/neutral-950, short of the 4.5:1 minimum for
// normal text. Inline `style` can't express a `dark:` variant, so red text
// uses this literal Tailwind arbitrary-value pair instead — computed
// contrast for #F0595F against both surfaces is ~5.4:1 (neutral-900) and
// ~5.9:1 (neutral-950). Written as a literal string (not built from the
// BRAND_RED constant above) because Tailwind's build-time scanner only sees
// raw source text, not evaluated JS — a template-interpolated class name is
// invisible to it.
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

function attendanceErrorMessage(result: { status: number; error?: string }): string {
  if (result.status === 400) {
    if (result.error === 'person_deactivated') return "Can't check in — that person is deactivated.";
    if (result.error === 'person_not_found') return 'Person not found — refreshing.';
    return GENERIC_ERROR;
  }
  if (result.status === 409) return 'Conflict — try again.';
  if (result.status === 404) return 'Already voided or not found — refreshing.';
  return GENERIC_ERROR;
}

// ---- Root component -----------------------------------------------------

export default function AdminClient({ adminEmail }: { adminEmail: string }) {
  const [people, setPeople] = useState<AdminPerson[] | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRow[] | null>(null);
  const [meetingDate, setMeetingDate] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [showDeactivated, setShowDeactivated] = useState(false);

  const [chipPendingId, setChipPendingId] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);

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
  // Both endpoints are fetched together on mount, whenever the "show
  // deactivated" toggle changes, and again after every mutation (attendance
  // toggle, person save, deactivate/reactivate). Those call sites don't
  // coordinate with each other — a chip tap and a Deactivate click can both
  // be in flight at once — so a slow response from an earlier request must
  // never clobber a fresher one. loadRequestIdRef is a monotonic counter
  // shared by every call: each request stamps its eventual response with the
  // counter value at issue time, and applyLoadResult discards any response
  // whose stamp no longer matches the current counter. Ported from the same
  // pattern in app/kiosk/kiosk-client.tsx.
  const loadRequestIdRef = useRef(0);

  const fetchAdminData = useCallback(async (includeDeactivated: boolean): Promise<LoadResult> => {
    try {
      const rosterUrl = includeDeactivated ? '/api/admin/roster?includeDeactivated=1' : '/api/admin/roster';
      const [rosterRes, attRes] = await Promise.all([
        fetch(rosterUrl),
        fetch('/api/admin/attendance'),
      ]);
      if (!rosterRes.ok || !attRes.ok) return { ok: false };
      const rosterData = (await rosterRes.json()) as RosterResponse;
      const attData = (await attRes.json()) as AttendanceResponse;
      return { ok: true, people: rosterData.people, attendance: attData.attendance, meetingDate: attData.meetingDate };
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
      status: 'member', // not shown/used in edit mode
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
  const saveDisabled = dialog?.mode === 'edit'
    ? Object.keys(updateFields ?? {}).length === 0
    : form.fullName.trim().length < 2;

  const handleSave = useCallback(async () => {
    if (!dialog || saving) return;
    setFormError(null);
    setSaving(true);

    const result = dialog.mode === 'create'
      ? await postJson<{ person: AdminPerson }>('/api/admin/roster', {
          action: 'create', fields: formToCreateFields(form), status: form.status,
        })
      : await postJson<{ person: AdminPerson }>('/api/admin/roster', {
          action: 'update', personId: dialog.person.id, fields: buildUpdateFields(form, dialog.person),
        });

    setSaving(false);
    if (!result.ok) {
      // 400 = validation the user can fix (highlighted fields). Anything
      // else (network drop, 500, …) isn't the user's fault and a toast alone
      // could be missed while heads-down in the dialog — surface it inline
      // too, and leave the dialog open with whatever was typed intact.
      if (result.status === 400) {
        setFormError('Check the highlighted fields and try again.');
      } else {
        setFormError(SAVE_CONNECTION_ERROR);
        showToast(GENERIC_ERROR);
      }
      return;
    }
    setDialog(null);
    showToast(dialog.mode === 'create' ? 'Person added' : 'Changes saved');
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

  // ---- Render ----

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-neutral-100 dark:bg-neutral-950 font-sans">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-5 sm:px-8">
        <span className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
          Wheeling · Admin
        </span>
        <div className="flex items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
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

          {!loadError && (people === null || attendance === null) && (
            <div className="mt-8 rounded-2xl bg-white p-8 text-center text-neutral-500 shadow-sm dark:bg-neutral-900 dark:text-neutral-400">
              Loading…
            </div>
          )}

          {!loadError && people !== null && attendance !== null && (
            <>
              <TodayPanel
                people={activePeople}
                attendanceByPerson={attendanceByPerson}
                pendingId={chipPendingId}
                onToggle={toggleAttendance}
              />
              <RosterPanel
                people={people}
                showDeactivated={showDeactivated}
                onToggleShowDeactivated={setShowDeactivated}
                deactivatingId={deactivatingId}
                reactivatingId={reactivatingId}
                onAdd={openCreateDialog}
                onEdit={openEditDialog}
                onDeactivate={handleDeactivate}
                onReactivate={handleReactivate}
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
  people, attendanceByPerson, pendingId, onToggle,
}: {
  people: AdminPerson[];
  attendanceByPerson: Map<string, AttendanceRow>;
  pendingId: string | null;
  onToggle: (personId: string) => void;
}) {
  const sorted = useMemo(
    () => [...people].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [people],
  );

  return (
    <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
        Today · {attendanceByPerson.size} checked in
      </h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Tap a person to add or void today&apos;s attendance
      </p>

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
  people, showDeactivated, onToggleShowDeactivated, deactivatingId, reactivatingId, onAdd, onEdit, onDeactivate, onReactivate,
}: {
  people: AdminPerson[];
  showDeactivated: boolean;
  onToggleShowDeactivated: (v: boolean) => void;
  deactivatingId: string | null;
  reactivatingId: string | null;
  onAdd: () => void;
  onEdit: (person: AdminPerson) => void;
  onDeactivate: (person: AdminPerson) => void;
  onReactivate: (person: AdminPerson) => void;
}) {
  const sorted = useMemo(
    () => [...people].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [people],
  );

  return (
    <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Roster</h2>
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
          <button
            type="button"
            onClick={onAdd}
            style={{ backgroundColor: BRAND_RED }}
            className="rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:scale-[0.98]"
          >
            + Add person
          </button>
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
                  onEdit={() => onEdit(p)}
                  onDeactivate={() => onDeactivate(p)}
                  onReactivate={() => onReactivate(p)}
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
  person, deactivating, reactivating, onEdit, onDeactivate, onReactivate,
}: {
  person: AdminPerson;
  deactivating: boolean;
  reactivating: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  const meta = STATUS_META[person.status];
  const deactivated = person.deactivatedAt !== null;
  return (
    <tr className={`border-t border-neutral-100 dark:border-neutral-800 ${deactivated ? 'opacity-60' : ''}`}>
      <td className="px-3 py-3 text-sm font-medium text-neutral-900 dark:text-neutral-50">{person.fullName}</td>
      <td className="px-3 py-3 text-sm text-neutral-600 dark:text-neutral-400">{person.industry ?? '—'}</td>
      <td className="px-3 py-3 text-sm text-neutral-600 dark:text-neutral-400">{person.email ?? '—'}</td>
      <td className="px-3 py-3">
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${meta.className}`}>
          {meta.label}
        </span>
      </td>
      <td className="px-3 py-3 text-right text-sm">
        {deactivated ? (
          <button
            type="button"
            onClick={onReactivate}
            disabled={reactivating}
            className="font-medium text-neutral-600 transition hover:underline disabled:opacity-50 dark:text-neutral-300"
          >
            {reactivating ? 'Reactivating…' : 'Reactivate'}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              disabled={deactivating}
              className="mr-4 font-medium text-neutral-600 transition hover:underline disabled:opacity-50 dark:text-neutral-300"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDeactivate}
              disabled={deactivating}
              className={`font-medium transition hover:underline disabled:opacity-50 ${RED_TEXT_CLASS}`}
            >
              {deactivating ? 'Deactivating…' : 'Deactivate'}
            </button>
          </>
        )}
      </td>
    </tr>
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
          {mode === 'create' && (
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
            </DialogField>
          )}

          <div className="mt-2 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-neutral-600 transition disabled:opacity-50 dark:text-neutral-300"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || saveDisabled}
              style={{ backgroundColor: BRAND_RED }}
              className="rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition active:scale-[0.98] disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
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
