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

const GENERIC_ERROR = 'Something went wrong — try again.';
const TOAST_MS = 2_500;

// Brand accent. Kept as a single JS constant for reference, but Tailwind's
// arbitrary-value classes must stay literal strings for its build-time
// scanner — see the equivalent comment in app/kiosk/kiosk-client.tsx. Any
// usage that needs to react to component state goes through inline `style`
// referencing this constant; static, always-red usages keep the literal
// Tailwind class.
const BRAND_RED = '#CF2030';

const ADMIN_INPUT_CLASS =
  'w-full rounded-xl border border-neutral-200 bg-transparent px-4 py-2.5 text-[15px] text-neutral-900 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:text-neutral-100 dark:focus:border-neutral-600';

const STATUS_META: Record<PersonStatus, { label: string; className: string }> = {
  leadership: { label: 'Leadership', className: 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' },
  member: { label: 'Member', className: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300' },
  visitor: { label: 'Visitor', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  former_member: { label: 'Former member', className: 'border border-dashed border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400' },
  none: { label: 'None', className: 'border border-dashed border-neutral-300 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500' },
};

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

  const [chipPendingId, setChipPendingId] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [form, setForm] = useState<PersonFormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
  // Both endpoints are fetched together on mount and again after every
  // mutation (attendance toggle, person save, deactivate) — there's no
  // polling here (unlike the kiosk), so a simple "fetch both, replace state"
  // is enough; no request-ordering guard is needed.

  const loadAll = useCallback(async () => {
    try {
      const [rosterRes, attRes] = await Promise.all([
        fetch('/api/admin/roster'),
        fetch('/api/admin/attendance'),
      ]);
      if (!rosterRes.ok || !attRes.ok) { setLoadError(true); return; }
      const rosterData = (await rosterRes.json()) as RosterResponse;
      const attData = (await attRes.json()) as AttendanceResponse;
      setPeople(rosterData.people);
      setAttendance(attData.attendance);
      setMeetingDate(attData.meetingDate);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    async function run() { await loadAll(); }
    run();
  }, [loadAll]);

  const attendanceByPerson = useMemo(
    () => new Map((attendance ?? []).map((a) => [a.personId, a])),
    [attendance],
  );

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
    loadAll();
  }, [chipPendingId, attendanceByPerson, showToast, loadAll]);

  // ---- Roster panel: create / edit / deactivate ----

  const openCreateDialog = useCallback(() => {
    setForm(emptyForm);
    setFormError(null);
    setDialog({ mode: 'create' });
  }, []);

  const openEditDialog = useCallback((person: AdminPerson) => {
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
      if (result.status === 400) {
        setFormError('Check the highlighted fields and try again.');
      } else {
        showToast(GENERIC_ERROR);
      }
      return;
    }
    setDialog(null);
    showToast(dialog.mode === 'create' ? 'Person added' : 'Changes saved');
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
                people={people}
                attendanceByPerson={attendanceByPerson}
                pendingId={chipPendingId}
                onToggle={toggleAttendance}
              />
              <RosterPanel
                people={people}
                deactivatingId={deactivatingId}
                onAdd={openCreateDialog}
                onEdit={openEditDialog}
                onDeactivate={handleDeactivate}
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
  people, deactivatingId, onAdd, onEdit, onDeactivate,
}: {
  people: AdminPerson[];
  deactivatingId: string | null;
  onAdd: () => void;
  onEdit: (person: AdminPerson) => void;
  onDeactivate: (person: AdminPerson) => void;
}) {
  const sorted = useMemo(
    () => [...people].sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [people],
  );

  return (
    <section className="mt-6 rounded-2xl bg-white p-6 shadow-sm dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Roster</h2>
        <button
          type="button"
          onClick={onAdd}
          style={{ backgroundColor: BRAND_RED }}
          className="rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition active:scale-[0.98]"
        >
          + Add person
        </button>
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
                  onEdit={() => onEdit(p)}
                  onDeactivate={() => onDeactivate(p)}
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
  person, deactivating, onEdit, onDeactivate,
}: {
  person: AdminPerson;
  deactivating: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
}) {
  const meta = STATUS_META[person.status];
  return (
    <tr className="border-t border-neutral-100 dark:border-neutral-800">
      <td className="px-3 py-3 text-sm font-medium text-neutral-900 dark:text-neutral-50">{person.fullName}</td>
      <td className="px-3 py-3 text-sm text-neutral-600 dark:text-neutral-400">{person.industry ?? '—'}</td>
      <td className="px-3 py-3 text-sm text-neutral-600 dark:text-neutral-400">{person.email ?? '—'}</td>
      <td className="px-3 py-3">
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${meta.className}`}>
          {meta.label}
        </span>
      </td>
      <td className="px-3 py-3 text-right text-sm">
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
          style={{ color: BRAND_RED }}
          className="font-medium transition hover:underline disabled:opacity-50"
        >
          {deactivating ? 'Deactivating…' : 'Deactivate'}
        </button>
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
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-dialog-title"
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-lg dark:bg-neutral-900"
      >
        <h2 id="person-dialog-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
          {mode === 'create' ? 'Add person' : 'Edit person'}
        </h2>

        {error && (
          <div style={{ color: BRAND_RED }} className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm dark:bg-red-950/40">
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
