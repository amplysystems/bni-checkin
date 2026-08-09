'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';

// ---- Types (mirrored from the kiosk API route contracts) ----------------

type Member = {
  id: string;
  fullName: string;
  displayName: string | null;
  industry: string | null;
  company: string | null;
  checkedInAt: string | null;
  attendanceId: string | null;
};

type RosterResponse = {
  greeting: string;
  meetingDate: string;
  members: Member[];
};

type SuggestionPerson = {
  id: string;
  fullName: string;
  industry: string | null;
  company: string | null;
};

type CheckinApiResponse = {
  checkedIn: boolean;
  deduped: boolean;
  voided: boolean;
  attendanceId: string;
  checkedInAt: string;
  visitNumber: number | null;
};

type UndoApiResponse = { undone: boolean };

type VisitorApiResponse =
  | { suggestions: SuggestionPerson[] }
  | { checkedIn: boolean; personId: string; fullName: string; attendanceId: string; visitNumber: number | null };

type ReturningApiResponse = { results: SuggestionPerson[] };

type View = 'grid' | 'splash' | 'visitorForm' | 'returningSearch';

type SplashInfo = { fullName: string; attendanceId: string; checkedInAt: string };

type VisitorFormState = {
  fullName: string;
  industry: string;
  company: string;
  email: string;
  phone: string;
};

const emptyVisitorForm: VisitorFormState = {
  fullName: '', industry: '', company: '', email: '', phone: '',
};

const GENERIC_ERROR = "Something went wrong — try again.";
const VOIDED_MESSAGE = 'Check-in was undone earlier — see an organizer';

// ---- Small pure helpers ---------------------------------------------------

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

function formatMeetingDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  }).format(dt);
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ---- Icons ------------------------------------------------------------

function CheckMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M5 12.5L10 17.5L19 7.5" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Root component -----------------------------------------------------

export default function KioskClient() {
  const [view, setView] = useState<View>('grid');
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [rosterError, setRosterError] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [splash, setSplash] = useState<SplashInfo | null>(null);
  const [undoing, setUndoing] = useState(false);

  const [visitorForm, setVisitorForm] = useState<VisitorFormState>(emptyVisitorForm);
  const [visitorError, setVisitorError] = useState<string | null>(null);
  const [visitorSubmitting, setVisitorSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionPerson[] | null>(null);
  const visitorOpIdRef = useRef<string | null>(null);

  const [returningQuery, setReturningQuery] = useState('');
  const [returningResults, setReturningResults] = useState<SuggestionPerson[]>([]);
  const [returningLoading, setReturningLoading] = useState(false);

  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text });
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // ---- Roster fetching ----
  // loadRoster is a pure fetch (no setState) so it's safe to invoke from an
  // effect; fetchRoster wraps it with state updates for use in event
  // handlers (post-mutation refreshes) outside of any effect body.

  const loadRoster = useCallback(async (): Promise<
    { ok: true; data: RosterResponse } | { ok: false }
  > => {
    try {
      const res = await fetch('/api/kiosk/roster');
      if (!res.ok) return { ok: false };
      return { ok: true, data: (await res.json()) as RosterResponse };
    } catch {
      return { ok: false };
    }
  }, []);

  const fetchRoster = useCallback(async () => {
    const result = await loadRoster();
    if (result.ok) { setRoster(result.data); setRosterError(false); }
    else setRosterError(true);
  }, [loadRoster]);

  // Fetches on mount, then polls every 30s while the grid view is active.
  useEffect(() => {
    let active = true;
    async function run() {
      const result = await loadRoster();
      if (!active) return;
      if (result.ok) { setRoster(result.data); setRosterError(false); }
      else setRosterError(true);
    }
    run();
    if (view !== 'grid') return () => { active = false; };
    const id = setInterval(run, 30000);
    return () => { active = false; clearInterval(id); };
  }, [view, loadRoster]);

  // ---- View transitions ----

  const resetToGrid = useCallback(() => {
    setView('grid');
    setSplash(null);
    setVisitorForm(emptyVisitorForm);
    setVisitorError(null);
    setSuggestions(null);
    visitorOpIdRef.current = null;
    setReturningQuery('');
    setReturningResults([]);
  }, []);

  const goToSplash = useCallback((info: SplashInfo) => {
    setSplash(info);
    setView('splash');
  }, []);

  useEffect(() => {
    if (view !== 'splash') return;
    const t = setTimeout(() => resetToGrid(), 5000);
    return () => clearTimeout(t);
  }, [view, resetToGrid]);

  // ---- Check-in (shared by grid taps, suggestion taps, and returning search taps) ----

  const performCheckIn = useCallback(async (personId: string, fallbackName: string) => {
    if (pendingId) return;
    setPendingId(personId);
    const clientOpId = crypto.randomUUID();
    const result = await postJson<CheckinApiResponse>('/api/kiosk/checkin', { personId, clientOpId });
    setPendingId(null);
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      return;
    }
    if (result.data.voided) {
      showToast(VOIDED_MESSAGE);
      return;
    }
    goToSplash({ fullName: fallbackName, attendanceId: result.data.attendanceId, checkedInAt: result.data.checkedInAt });
    fetchRoster();
  }, [pendingId, showToast, goToSplash, fetchRoster]);

  const performUndo = useCallback(async (attendanceId: string) => {
    setUndoing(true);
    const result = await postJson<UndoApiResponse>('/api/kiosk/undo', { attendanceId });
    setUndoing(false);
    if (!result.ok) {
      showToast(GENERIC_ERROR);
      return;
    }
    // The route can 200 with undone: false (already voided, cross-day, or a
    // bad id) — that's not a network/request failure, just a no-op. Either
    // way we return to grid and refresh so the roster reflects true state.
    showToast(result.data.undone ? 'Check-in removed' : "Couldn't undo — see an organizer");
    resetToGrid();
    fetchRoster();
  }, [showToast, resetToGrid, fetchRoster]);

  // ---- Visitor form ----

  const ensureOpId = useCallback(() => {
    if (!visitorOpIdRef.current) visitorOpIdRef.current = crypto.randomUUID();
    return visitorOpIdRef.current;
  }, []);

  const openVisitorForm = useCallback(() => {
    visitorOpIdRef.current = null;
    setVisitorForm(emptyVisitorForm);
    setVisitorError(null);
    setSuggestions(null);
    setView('visitorForm');
  }, []);

  const submitVisitor = useCallback(async (confirmedNew: boolean) => {
    if (visitorSubmitting) return;
    setVisitorError(null);
    setVisitorSubmitting(true);
    const opId = ensureOpId();
    const payload = {
      fullName: visitorForm.fullName,
      industry: visitorForm.industry,
      company: visitorForm.company.trim() === '' ? null : visitorForm.company,
      email: visitorForm.email,
      phone: visitorForm.phone.trim() === '' ? null : visitorForm.phone,
      clientOpId: opId,
      confirmedNew,
    };
    const result = await postJson<VisitorApiResponse>('/api/kiosk/visitor', payload);
    setVisitorSubmitting(false);
    if (!result.ok) {
      if (result.status === 400) {
        setVisitorError('Check the highlighted fields — name, industry, and a valid email are needed.');
      } else {
        showToast(GENERIC_ERROR);
      }
      return;
    }
    const data = result.data;
    if ('suggestions' in data) {
      setSuggestions(data.suggestions);
      return;
    }
    setSuggestions(null);
    if (!data.checkedIn) {
      showToast(VOIDED_MESSAGE);
      resetToGrid();
      return;
    }
    goToSplash({ fullName: data.fullName, attendanceId: data.attendanceId, checkedInAt: new Date().toISOString() });
    fetchRoster();
  }, [visitorSubmitting, ensureOpId, visitorForm, showToast, resetToGrid, goToSplash, fetchRoster]);

  const openReturningSearch = useCallback(() => {
    setReturningQuery('');
    setReturningResults([]);
    setView('returningSearch');
  }, []);

  // ---- Returning search (debounced) ----
  // Below 2 chars we simply skip fetching — displayedResults (derived below)
  // renders empty in that case rather than resetting state synchronously
  // here, since resetting on every keystroke is what the query is meant to
  // be derived from, not something an effect should own.

  useEffect(() => {
    if (view !== 'returningSearch') return;
    const q = returningQuery.trim();
    if (q.length < 2) return;
    let ignore = false;
    const timer = setTimeout(async () => {
      setReturningLoading(true);
      try {
        const res = await fetch(`/api/kiosk/returning?q=${encodeURIComponent(q)}`);
        if (ignore) return;
        if (!res.ok) { setReturningResults([]); return; }
        const data = (await res.json()) as ReturningApiResponse;
        if (!ignore) setReturningResults(data.results);
      } catch {
        if (!ignore) setReturningResults([]);
      } finally {
        if (!ignore) setReturningLoading(false);
      }
    }, 250);
    return () => { ignore = true; clearTimeout(timer); };
  }, [returningQuery, view]);

  // ---- Derived data ----

  const filteredMembers = useMemo(() => {
    if (!roster) return [];
    const q = query.trim().toLowerCase();
    if (!q) return roster.members;
    return roster.members.filter((m) => {
      const name = (m.displayName ?? m.fullName).toLowerCase();
      return name.includes(q) || m.fullName.toLowerCase().includes(q);
    });
  }, [roster, query]);

  const nameValid = visitorForm.fullName.trim().length >= 2;
  const industryValid = visitorForm.industry.trim().length >= 2;
  const emailValid = isValidEmail(visitorForm.email);

  const returningQueryLongEnough = returningQuery.trim().length >= 2;
  const displayedReturningResults = returningQueryLongEnough ? returningResults : [];
  const returningIsLoading = returningLoading && returningQueryLongEnough;

  // ---- Render ----

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-neutral-100 dark:bg-neutral-950">
      <header className="flex items-center justify-between px-4 pt-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <Image
            src="/bni-logo.jpg"
            alt="BNI"
            width={160}
            height={90}
            priority
            className="h-8 w-auto rounded-sm sm:h-9"
          />
          <span className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Wheeling
          </span>
        </div>
        {roster && (
          <div className="rounded-full bg-white px-3.5 py-1.5 text-sm font-medium text-neutral-600 shadow-sm dark:bg-neutral-900 dark:text-neutral-300">
            {formatMeetingDate(roster.meetingDate)}
          </div>
        )}
      </header>

      {view === 'grid' && (
        <GridView
          roster={roster}
          rosterError={rosterError}
          query={query}
          setQuery={setQuery}
          filteredMembers={filteredMembers}
          pendingId={pendingId}
          onTapMember={(m) => performCheckIn(m.id, m.displayName ?? m.fullName)}
          onOpenVisitorForm={openVisitorForm}
        />
      )}

      {view === 'splash' && splash && (
        <SplashView
          info={splash}
          undoing={undoing}
          onUndo={() => performUndo(splash.attendanceId)}
        />
      )}

      {view === 'visitorForm' && (
        <VisitorFormView
          form={visitorForm}
          setForm={setVisitorForm}
          error={visitorError}
          submitting={visitorSubmitting}
          suggestions={suggestions}
          pendingId={pendingId}
          nameValid={nameValid}
          industryValid={industryValid}
          emailValid={emailValid}
          onSubmit={() => submitVisitor(false)}
          onPickSuggestion={(s) => performCheckIn(s.id, s.fullName)}
          onNotThatPerson={() => submitVisitor(true)}
          onFindReturning={openReturningSearch}
          onBack={resetToGrid}
        />
      )}

      {view === 'returningSearch' && (
        <ReturningSearchView
          query={returningQuery}
          setQuery={setReturningQuery}
          results={displayedReturningResults}
          loading={returningIsLoading}
          pendingId={pendingId}
          onPick={(r) => performCheckIn(r.id, r.fullName)}
          onBack={() => setView('visitorForm')}
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 flex justify-center px-4">
          <div className="pointer-events-auto rounded-full bg-neutral-900 px-5 py-3 text-sm font-medium text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900">
            {toast.text}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Grid view ----------------------------------------------------------

function GridView({
  roster, rosterError, query, setQuery, filteredMembers, pendingId, onTapMember, onOpenVisitorForm,
}: {
  roster: RosterResponse | null;
  rosterError: boolean;
  query: string;
  setQuery: (v: string) => void;
  filteredMembers: Member[];
  pendingId: string | null;
  onTapMember: (m: Member) => void;
  onOpenVisitorForm: () => void;
}) {
  return (
    <main className="flex-1 px-4 pb-12 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl dark:text-neutral-50">
          {roster?.greeting ?? 'Welcome'}
        </h1>
        <p className="mt-1.5 text-neutral-500 dark:text-neutral-400">Tap your name to check in</p>

        <div className="mt-6">
          <input
            type="search"
            inputMode="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your name"
            aria-label="Search your name"
            className="min-h-[56px] w-full rounded-2xl border border-neutral-200 bg-white px-5 text-base text-neutral-900 shadow-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-50 dark:placeholder:text-neutral-500 dark:focus:border-neutral-600"
          />
        </div>

        {rosterError && (
          <div className="mt-8 rounded-2xl bg-white p-8 text-center text-neutral-500 shadow-sm dark:bg-neutral-900 dark:text-neutral-400">
            Can&apos;t reach the roster — check the connection
          </div>
        )}

        {!rosterError && roster && (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
            {filteredMembers.map((m) => (
              <MemberCard
                key={m.id}
                member={m}
                pending={pendingId === m.id}
                onTap={() => onTapMember(m)}
              />
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={onOpenVisitorForm}
          className="mt-10 min-h-[64px] w-full rounded-2xl bg-[#CF2030] px-6 text-lg font-semibold text-white shadow-sm transition active:scale-[0.98]"
        >
          First time here? Welcome →
        </button>

        <footer className="mt-10 flex items-center justify-center gap-2 pb-4 text-sm text-neutral-400 dark:text-neutral-600">
          <span>Powered by</span>
          <span className="flex items-center gap-1.5 font-medium text-neutral-500 dark:text-neutral-400">
            amply
            <span className="inline-block h-2 w-2 bg-[#2563FF]" />
          </span>
        </footer>
      </div>
    </main>
  );
}

function MemberCard({ member, pending, onTap }: { member: Member; pending: boolean; onTap: () => void }) {
  const checkedIn = member.checkedInAt !== null;
  const name = member.displayName ?? member.fullName;

  return (
    <button
      type="button"
      disabled={checkedIn || pending}
      onClick={onTap}
      className="flex min-h-[64px] flex-col items-center gap-2 rounded-2xl bg-white p-4 text-center shadow-sm transition active:scale-[0.98] disabled:active:scale-100 dark:bg-neutral-900"
    >
      <span
        className={`flex h-14 w-14 items-center justify-center rounded-full text-lg font-semibold ${
          checkedIn
            ? 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400'
            : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
        } ${pending ? 'opacity-50' : ''}`}
      >
        {checkedIn ? <CheckMark className="h-6 w-6" /> : getInitials(name)}
      </span>
      <span className="line-clamp-1 text-sm font-medium text-neutral-900 dark:text-neutral-50">{name}</span>
      {checkedIn ? (
        <span className="text-xs font-medium text-green-600 dark:text-green-400">
          Checked in · {formatTime(member.checkedInAt!)}
        </span>
      ) : (
        member.industry && (
          <span className="line-clamp-1 text-xs text-neutral-500 dark:text-neutral-400">{member.industry}</span>
        )
      )}
    </button>
  );
}

// ---- Splash view ----------------------------------------------------------

function SplashView({ info, undoing, onUndo }: { info: SplashInfo; undoing: boolean; onUndo: () => void }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40">
        <CheckMark className="h-12 w-12 text-green-600 dark:text-green-400" />
      </div>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl dark:text-neutral-50">
        You&apos;re in, {firstNameOf(info.fullName)}
      </h1>
      <p className="mt-2 text-neutral-500 dark:text-neutral-400">
        Checked in at {formatTime(info.checkedInAt)}
      </p>
      <button
        type="button"
        onClick={onUndo}
        disabled={undoing}
        className="mt-6 flex min-h-[56px] items-center justify-center px-6 text-sm font-medium text-[#CF2030] transition active:scale-[0.98] disabled:opacity-50"
      >
        Not you? Undo
      </button>
    </main>
  );
}

// ---- Visitor form view ----------------------------------------------------

function VisitorFormView({
  form, setForm, error, submitting, suggestions, pendingId, nameValid, industryValid, emailValid,
  onSubmit, onPickSuggestion, onNotThatPerson, onFindReturning, onBack,
}: {
  form: VisitorFormState;
  setForm: (updater: (f: VisitorFormState) => VisitorFormState) => void;
  error: string | null;
  submitting: boolean;
  suggestions: SuggestionPerson[] | null;
  pendingId: string | null;
  nameValid: boolean;
  industryValid: boolean;
  emailValid: boolean;
  onSubmit: () => void;
  onPickSuggestion: (s: SuggestionPerson) => void;
  onNotThatPerson: () => void;
  onFindReturning: () => void;
  onBack: () => void;
}) {
  const errBorder = 'border-[#CF2030] focus:border-[#CF2030]';
  const okBorder = 'border-neutral-200 focus:border-neutral-400 dark:border-neutral-800 dark:focus:border-neutral-600';

  return (
    <main className="flex-1 px-4 pb-12 sm:px-8">
      <div className="mx-auto max-w-lg">
        <button
          type="button"
          onClick={onBack}
          className="mt-4 flex min-h-[48px] items-center text-sm font-medium text-neutral-500 transition active:scale-[0.98] dark:text-neutral-400"
        >
          ← Back
        </button>

        {suggestions && suggestions.length > 0 ? (
          <div className="mt-4">
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Looks like you may have visited before — is this you?
            </h1>
            <div className="mt-6 flex flex-col gap-3">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={pendingId === s.id}
                  onClick={() => onPickSuggestion(s)}
                  className="min-h-[64px] rounded-2xl bg-white p-4 text-left shadow-sm transition active:scale-[0.98] disabled:opacity-50 dark:bg-neutral-900"
                >
                  <div className="font-medium text-neutral-900 dark:text-neutral-50">{s.fullName}</div>
                  {(s.industry || s.company) && (
                    <div className="text-sm text-neutral-500 dark:text-neutral-400">
                      {[s.industry, s.company].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onNotThatPerson}
              disabled={submitting}
              className="mt-6 min-h-[56px] w-full rounded-2xl border border-neutral-200 text-base font-medium text-neutral-700 transition active:scale-[0.98] disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-200"
            >
              No — I&apos;m new here
            </button>
          </div>
        ) : (
          <form
            className="mt-4"
            onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
          >
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Welcome — tell us about you
            </h1>

            {error && (
              <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-[#CF2030] dark:bg-red-950/40">
                {error}
              </div>
            )}

            <div className="mt-6 flex flex-col gap-4">
              <Field label="Full name">
                <input
                  type="text"
                  required
                  minLength={2}
                  value={form.fullName}
                  onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
                  className={`min-h-[56px] w-full rounded-2xl border bg-white px-5 text-base text-neutral-900 shadow-sm outline-none dark:bg-neutral-900 dark:text-neutral-50 ${error && !nameValid ? errBorder : okBorder}`}
                />
              </Field>
              <Field label="Industry">
                <input
                  type="text"
                  required
                  minLength={2}
                  value={form.industry}
                  onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))}
                  className={`min-h-[56px] w-full rounded-2xl border bg-white px-5 text-base text-neutral-900 shadow-sm outline-none dark:bg-neutral-900 dark:text-neutral-50 ${error && !industryValid ? errBorder : okBorder}`}
                />
              </Field>
              <Field label="Company (optional)">
                <input
                  type="text"
                  value={form.company}
                  onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                  className={`min-h-[56px] w-full rounded-2xl border bg-white px-5 text-base text-neutral-900 shadow-sm outline-none dark:bg-neutral-900 dark:text-neutral-50 ${okBorder}`}
                />
              </Field>
              <Field label="Work email">
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className={`min-h-[56px] w-full rounded-2xl border bg-white px-5 text-base text-neutral-900 shadow-sm outline-none dark:bg-neutral-900 dark:text-neutral-50 ${error && !emailValid ? errBorder : okBorder}`}
                />
              </Field>
              <Field label="Phone (optional)">
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  className={`min-h-[56px] w-full rounded-2xl border bg-white px-5 text-base text-neutral-900 shadow-sm outline-none dark:bg-neutral-900 dark:text-neutral-50 ${okBorder}`}
                />
              </Field>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="mt-8 min-h-[64px] w-full rounded-2xl bg-[#CF2030] text-lg font-semibold text-white shadow-sm transition active:scale-[0.98] disabled:opacity-60"
            >
              {submitting ? 'Checking in…' : 'Check in'}
            </button>

            <button
              type="button"
              onClick={onFindReturning}
              className="mt-4 flex min-h-[48px] w-full items-center justify-center text-sm font-medium text-neutral-500 transition active:scale-[0.98] dark:text-neutral-400"
            >
              Been here before? Find your name
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

// ---- Returning search view -------------------------------------------------

function ReturningSearchView({
  query, setQuery, results, loading, pendingId, onPick, onBack,
}: {
  query: string;
  setQuery: (v: string) => void;
  results: SuggestionPerson[];
  loading: boolean;
  pendingId: string | null;
  onPick: (s: SuggestionPerson) => void;
  onBack: () => void;
}) {
  return (
    <main className="flex-1 px-4 pb-12 sm:px-8">
      <div className="mx-auto max-w-lg">
        <button
          type="button"
          onClick={onBack}
          className="mt-4 flex min-h-[48px] items-center text-sm font-medium text-neutral-500 transition active:scale-[0.98] dark:text-neutral-400"
        >
          ← Back to visitor form
        </button>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
          Find your name
        </h1>

        <input
          type="search"
          inputMode="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Start typing your name"
          aria-label="Search your name"
          className="mt-6 min-h-[56px] w-full rounded-2xl border border-neutral-200 bg-white px-5 text-base text-neutral-900 shadow-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-50 dark:placeholder:text-neutral-500 dark:focus:border-neutral-600"
        />

        <div className="mt-6 flex flex-col gap-3">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={pendingId === r.id}
              onClick={() => onPick(r)}
              className="min-h-[64px] rounded-2xl bg-white p-4 text-left shadow-sm transition active:scale-[0.98] disabled:opacity-50 dark:bg-neutral-900"
            >
              <div className="font-medium text-neutral-900 dark:text-neutral-50">{r.fullName}</div>
              {(r.industry || r.company) && (
                <div className="text-sm text-neutral-500 dark:text-neutral-400">
                  {[r.industry, r.company].filter(Boolean).join(' · ')}
                </div>
              )}
            </button>
          ))}
          {!loading && query.trim().length >= 2 && results.length === 0 && (
            <div className="rounded-2xl bg-white p-6 text-center text-neutral-500 shadow-sm dark:bg-neutral-900 dark:text-neutral-400">
              No matches — try a different spelling, or go back to register as new.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
