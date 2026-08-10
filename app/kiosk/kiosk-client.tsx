'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';

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

type View = 'grid' | 'splash' | 'visitorForm' | 'returningSearch' | 'attract';

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

// Timing knobs, named so the setTimeout/setInterval calls below read as
// intent rather than magic numbers.
const POLL_INTERVAL_MS = 30_000;
const SPLASH_MS = 3_000;
const TOAST_MS = 2_500;
const SEARCH_DEBOUNCE_MS = 250;
const IDLE_MS = 45_000;
const CROSSFADE_MS = 8_000;

// The four ad creatives (see public/ads/) — shared by the attract loop
// slideshow and the splash backdrop.
const ADS = ['/ads/hero.jpg', '/ads/deserves.jpg', '/ads/building.jpg', '/ads/ask.jpg'] as const;

// Used to pick "the day's ad" for the splash backdrop — deterministic per
// day (not per render), so it doesn't flicker between different check-ins
// on the same day, and rotates on its own as days pass without needing a
// stored index anywhere.
function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const diff = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start;
  return Math.floor(diff / 86_400_000);
}

// AttractView's prefers-reduced-motion check, via useSyncExternalStore
// rather than the more familiar "useState + read-in-a-mount-effect"
// pattern — the latter calls setState synchronously on every mount to sync
// from an external source (the MediaQueryList), which is exactly the
// footgun useSyncExternalStore exists to replace (safe under concurrent
// rendering, and no SSR/hydration mismatch since getServerSnapshot below
// gives a fixed, non-throwing value before window exists).
function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
function getReducedMotionSnapshot(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function getReducedMotionServerSnapshot(): boolean {
  return false; // no window server-side; client re-syncs the real value immediately after hydration
}

// Brand accent. Kept as a single JS constant for reference, but Tailwind's
// arbitrary-value classes (bg-[#CF2030] etc.) must stay literal strings for
// its build-time scanner to generate them — a dynamically-interpolated
// class name is invisible to that scanner and silently produces no CSS. So
// any usage that needs to react to component state (form-field error
// highlighting) goes through an inline `style` referencing this constant
// instead of a dynamic class name; static, always-red usages keep the
// literal Tailwind class.
const BRAND_RED = '#CF2030';

// Shared by every visitor-form text input; only the border reacts to
// validation state, via VISITOR_INPUT_ERROR_STYLE below.
const VISITOR_INPUT_CLASS =
  'min-h-[56px] w-full rounded-2xl border bg-white px-5 text-base text-neutral-900 shadow-sm outline-none dark:bg-neutral-900 dark:text-neutral-50 border-neutral-200 focus:border-neutral-400 dark:border-neutral-800 dark:focus:border-neutral-600';
const VISITOR_INPUT_ERROR_STYLE = { borderColor: BRAND_RED } as const;

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

const CLOCK_TICK_MS = 15_000;

function formatClock(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
  }).format(d);
}

// Live venue clock — feeds both the header pill (KioskTopBar, mobile/other
// views) and the split rail's large clock (KioskRail, md+ grid view). Lazy
// initializer + interval-driven updates keep setState out of the effect body
// (react-hooks/set-state-in-effect).
function useClock(): string {
  const [time, setTime] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = setInterval(() => setTime(formatClock(new Date())), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return time;
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

// amply-logo.png is the real brand asset (cream wordmark + blue square) —
// it's designed to sit on a dark background, so it gets its own fixed navy
// pill rather than the page background. The pill is intentionally identical
// in both themes: the logo needs the dark surface to read correctly either
// way, unlike the rest of the page which flips with the OS theme.
const AMPLY_PILL_NAVY = '#0c1322';

// The md+ split-rail's fixed background (app/kiosk/kiosk-client.tsx's
// KioskRail below) — always dark regardless of the OS theme, same rationale
// as AMPLY_PILL_NAVY just above: it's a distinct surface from the page, not
// something that should flip with dark:.
const RAIL_NAVY = '#0b0f19';

function AmplyFooter() {
  return (
    <footer className="mt-10 flex items-center justify-center gap-2 pb-4 text-sm text-neutral-400 dark:text-neutral-500">
      <span>Powered by</span>
      <span
        className="inline-flex items-center rounded-full px-3 py-1.5"
        style={{ backgroundColor: AMPLY_PILL_NAVY }}
      >
        <Image src="/amply-logo.png" alt="Amply Systems" width={45} height={16} className="h-4 w-auto" />
      </span>
      <a
        href="/admin"
        className="ml-3 min-h-[44px] inline-flex items-center px-2 text-xs text-neutral-400 underline-offset-2 hover:underline dark:text-neutral-600"
      >
        Admin
      </a>
    </footer>
  );
}

// Rail-bottom equivalent of AmplyFooter, for the md+ split rail (KioskRail
// below). Same content (Powered-by pill + quiet Admin link), but the rail's
// surface is a fixed dark navy regardless of OS theme — see SplashView's
// docblock (app/kiosk/kiosk-client.tsx) for why fixed colors, not `dark:`
// pairs, are correct on an always-dark surface. Not merged into AmplyFooter
// itself since the two now have different layouts (row vs. stacked) and
// color schemes (theme-reactive vs. fixed).
function RailAmplyFooter() {
  return (
    <footer className="flex flex-col items-start gap-3">
      <div className="flex items-center gap-2 text-sm text-neutral-400">
        <span>Powered by</span>
        <span
          className="inline-flex items-center rounded-full px-3 py-1.5"
          style={{ backgroundColor: AMPLY_PILL_NAVY }}
        >
          <Image src="/amply-logo.png" alt="Amply Systems" width={45} height={16} className="h-4 w-auto" />
        </span>
      </div>
      <a
        href="/admin"
        className="min-h-[44px] inline-flex items-center text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
      >
        Admin
      </a>
    </footer>
  );
}

// The two rotating campaign lines for the rail's bottom (and, statically, the
// login rail — app/admin/login/page.tsx). Alternates by day-of-year using the
// same dayOfYear() selection already used for the daily ad (dailyAdSrc in
// KioskClient below), so it changes once a day rather than per render.
function CampaignLine({ index }: { index: number }) {
  // text-2xl, not text-3xl: measured live against this 300px rail's usable
  // width (236px) — at text-3xl, "One plumber." (the shortest of the three
  // scripted lines) still wraps mid-phrase into "One" / "plumber." on two
  // lines, since Unbounded is noticeably wider than the Archivo this
  // replaced (see app/layout.tsx). text-2xl keeps every line of both
  // rotating variants' shorter phrases on one line; the longer phrases in
  // the second variant ("The best opportunities" / "They're across the
  // table.") are long enough in plain English that they still wrap even at
  // this size — that's a copy-length issue, not something a font-size
  // tweak alone can fully solve, and rewriting the approved campaign copy
  // is out of scope here.
  //
  // font-black (900), not font-extrabold (800) — only 700/900 are loaded
  // for Unbounded (see app/layout.tsx), so 800 isn't an actual loaded
  // weight.
  const className =
    'font-display text-2xl font-black leading-tight tracking-tight text-neutral-50';
  if (index % 2 === 0) {
    return (
      <p className={className}>
        One plumber.
        <br />
        One lawyer.
        <br />
        <span style={{ color: BRAND_RED }}>One of you.</span>
      </p>
    );
  }
  // Rail-fit cut of the campaign line: the full tagline's closing phrase
  // ("They're across the table.") can't fit the 300px rail at a legible
  // size, so the rail runs the three-word form with deliberate breaks —
  // the full line lives on in the ad creatives themselves.
  return (
    <p className={className}>
      The best
      <br />
      opportunities
      <br />
      <span style={{ color: BRAND_RED }}>aren&apos;t online.</span>
    </p>
  );
}

// Shared top bar: BNI mark + "Wheeling" wordmark, and (once the roster has
// loaded) the date · live-clock pill. Used as-is for the splash / visitor
// form / returning search views (unchanged from before the split-rail
// redesign), and again — restricted to `md:hidden` — as the grid view's
// mobile-only top bar, since the grid's md+ header content now lives in
// KioskRail instead.
function KioskTopBar({
  roster, clock, className = '',
}: {
  roster: RosterResponse | null;
  clock: string;
  className?: string;
}) {
  return (
    <header className={`flex items-center justify-between px-4 pt-5 sm:px-8 ${className}`}>
      <div className="flex items-center gap-2.5">
        <Image
          src="/bni-logo-transparent.png"
          alt="BNI"
          width={160}
          height={90}
          priority
          className="h-8 w-auto sm:h-9"
        />
        <span className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
          Wheeling
        </span>
      </div>
      {roster && (
        <div className="rounded-full bg-white px-3.5 py-1.5 text-sm font-medium text-neutral-600 shadow-sm dark:bg-neutral-900 dark:text-neutral-300">
          {formatMeetingDate(roster.meetingDate)} · {clock}
        </div>
      )}
    </header>
  );
}

// ---- Split rail (md+ grid view only) --------------------------------------
//
// The grid view's left rail: brand mark, a large live clock, a rotating
// campaign line, and the amply/admin footer — fixed-width and always dark
// (RAIL_NAVY), independent of the OS theme, same rationale as the amply pill.
// `hidden md:flex`: below md the grid view falls back to the single-column
// mobile layout (KioskTopBar + GridView's own AmplyFooter), so this never
// renders there. Only ever mounted while view === 'grid' — splash and attract
// render as their own exclusive views (see KioskClient's render switch), so
// there's no risk of the rail showing through underneath them.
function KioskRail({ roster, clock }: { roster: RosterResponse | null; clock: string }) {
  const campaignIndex = useMemo(() => dayOfYear(new Date()) % 2, []);

  return (
    <aside
      className="hidden md:flex md:min-h-screen md:w-[300px] md:flex-none md:flex-col md:px-8 md:py-8"
      style={{ backgroundColor: RAIL_NAVY }}
    >
      <div className="flex items-center gap-2.5">
        <Image src="/bni-logo-transparent.png" alt="BNI" width={160} height={90} priority className="h-10 w-auto" />
        <span className="text-lg font-semibold tracking-tight text-neutral-50">Wheeling</span>
      </div>

      <div className="mt-14">
        {/* text-4xl, not text-6xl: Unbounded is noticeably wider than
            Archivo was (see app/layout.tsx). Measured live against this
            300px rail's usable width (300px minus the rail's own px-8
            padding = 236px): text-6xl and text-5xl both wrap a double-digit
            hour + "PM" onto two lines ("10:08" / "PM"), which is exactly the
            broken-looking reflow a live-updating clock must never do.
            text-4xl is the largest size that keeps every hour on one line —
            the widest measured ("10:00 AM") renders at ~217px, ~19px of
            room to spare. font-black (900), not font-extrabold (800), for
            the same loaded-weight reason as CampaignLine above. */}
        <p className="font-display text-4xl font-black tracking-tight text-neutral-50">{clock}</p>
        {roster && (
          <p className="mt-2 text-sm text-neutral-400">{formatMeetingDate(roster.meetingDate)}</p>
        )}
      </div>

      <div className="flex-1" />

      <CampaignLine index={campaignIndex} />

      <div className="mt-8">
        <RailAmplyFooter />
      </div>
    </aside>
  );
}

// ---- Attract loop -----------------------------------------------------

// Entered after IDLE_MS of no interaction on the grid (see KioskClient's
// idle-timer effect). Deliberately a single plain <button> covering the
// screen rather than a modal/dialog — no role="dialog", no focus trap, no
// captured Tab order. That's the whole point: it must never interfere with
// Guided Access or leave a keyboard/AT user stuck. Any pointerdown or
// keydown anywhere on it exits back to the grid.
function AttractView({ startIndex, onExit }: { startIndex: number; onExit: () => void }) {
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
  const [activeIndex, setActiveIndex] = useState(startIndex % ADS.length);

  // Advances the slideshow every CROSSFADE_MS. Skipped entirely under
  // reduced motion — that branch below renders one static image (still
  // "rotated" per entry via startIndex) and never advances it.
  useEffect(() => {
    if (reducedMotion) return;
    const id = setInterval(() => {
      setActiveIndex((i) => (i + 1) % ADS.length);
    }, CROSSFADE_MS);
    return () => clearInterval(id);
  }, [reducedMotion]);

  return (
    <button
      type="button"
      onPointerDown={onExit}
      onKeyDown={onExit}
      aria-label="Tap anywhere to check in"
      className="fixed inset-0 z-40 h-screen w-screen overflow-hidden bg-black text-left"
    >
      {reducedMotion ? (
        <Image
          src={ADS[activeIndex]}
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
      ) : (
        ADS.map((src, i) => (
          <Image
            key={src}
            src={src}
            alt=""
            fill
            priority={i === startIndex % ADS.length}
            sizes="100vw"
            className={`object-cover transition-opacity duration-[1500ms] ease-in-out ${
              i === activeIndex ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ))
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
      <p className="absolute inset-x-0 bottom-8 text-center text-sm font-medium text-white">
        Tap anywhere to check in
      </p>
    </button>
  );
}

// ---- Root component -----------------------------------------------------

export default function KioskClient() {
  const [view, setView] = useState<View>('grid');
  const clock = useClock();
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [rosterError, setRosterError] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [splash, setSplash] = useState<SplashInfo | null>(null);
  const [undoing, setUndoing] = useState(false);

  // The day's ad for the splash backdrop — computed once per mount (a kiosk
  // session spans a single meeting, not multiple days) rather than on every
  // render.
  const dailyAdSrc = useMemo(() => ADS[dayOfYear(new Date()) % ADS.length], []);

  // Root container ref: the idle-reset listeners below attach here (not
  // window) per spec, and it doubles as the attract loop's full-bleed
  // backdrop container.
  const rootRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Increments every time the kiosk goes idle into the attract loop, so each
  // entry starts on a different ad ("rotate choice per entry") without
  // needing to persist which one was shown last across AttractView's own
  // mount/unmount cycles. State, not a ref, because it's read during render
  // (passed to AttractView as a prop) — reading a ref's .current during
  // render isn't safe (see react-hooks/refs).
  const [attractEntryCount, setAttractEntryCount] = useState(0);

  // Idle-to-attract timer. Deliberately scoped to view === 'grid' only —
  // someone mid check-in (splash/visitor form/returning search) must never
  // get yanked into the ad slideshow. Listens for pointerdown/keydown on the
  // root container (not window) to reset the countdown on any real
  // interaction with the grid.
  useEffect(() => {
    if (view !== 'grid') return;
    const container = rootRef.current;
    if (!container) return;

    function resetIdleTimer() {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        setAttractEntryCount((n) => n + 1);
        setView('attract');
      }, IDLE_MS);
    }

    resetIdleTimer();
    container.addEventListener('pointerdown', resetIdleTimer);
    container.addEventListener('keydown', resetIdleTimer);
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
      container.removeEventListener('pointerdown', resetIdleTimer);
      container.removeEventListener('keydown', resetIdleTimer);
    };
  }, [view]);

  // Exiting the attract loop just flips the view back to 'grid' — the
  // existing grid-entry effect below (view !== 'grid' ? return : fetch...)
  // already re-fetches the roster whenever `view` transitions to 'grid', so
  // there's no need to duplicate that fetch here.
  const exitAttract = useCallback(() => setView('grid'), []);

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
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // ---- Roster fetching ----
  // loadRoster is a pure fetch (no setState) so it's safe to invoke from an
  // effect; fetchRoster wraps it with state updates for use in event
  // handlers (post-mutation refreshes) outside of any effect body.
  //
  // rosterRequestIdRef is a monotonic counter shared by every fetch path —
  // mount/grid-entry, the 30s poll, and post-mutation refreshes. Each fetch
  // stamps its eventual response with the counter value at issue time;
  // applyRosterResult discards any response whose stamp no longer matches
  // the current counter. That keeps a slow poll from clobbering a fresher
  // mutation-triggered refresh (or vice versa) regardless of resolution
  // order — only the most recently issued request's response ever gets
  // applied to state.
  const rosterRequestIdRef = useRef(0);

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

  const applyRosterResult = useCallback(
    (requestId: number, result: { ok: true; data: RosterResponse } | { ok: false }) => {
      if (requestId !== rosterRequestIdRef.current) return; // superseded by a newer request
      if (result.ok) { setRoster(result.data); setRosterError(false); }
      else setRosterError(true);
    },
    [],
  );

  const fetchRoster = useCallback(async () => {
    const requestId = ++rosterRequestIdRef.current;
    const result = await loadRoster();
    applyRosterResult(requestId, result);
  }, [loadRoster, applyRosterResult]);

  // Fetches immediately on entering the grid view, then polls every
  // POLL_INTERVAL_MS while it stays active. Both the initial run() and the
  // interval are gated behind view === 'grid' so navigating away (splash,
  // visitor form, returning search) stops the polling entirely.
  useEffect(() => {
    if (view !== 'grid') return;
    let cancelled = false;
    async function run() {
      const requestId = ++rosterRequestIdRef.current;
      const result = await loadRoster();
      if (cancelled) return;
      applyRosterResult(requestId, result);
    }
    run();
    const id = setInterval(run, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [view, loadRoster, applyRosterResult]);

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
    const t = setTimeout(() => resetToGrid(), SPLASH_MS);
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
    }, SEARCH_DEBOUNCE_MS);
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
    <div ref={rootRef} className="flex min-h-screen flex-1 flex-col bg-neutral-100 dark:bg-neutral-950">
      {/* Splash / visitor form / returning search keep the original
          single-column top bar unchanged (KioskTopBar with no className —
          full width at every breakpoint). The grid view no longer uses this
          copy: its own md+ header content lives in KioskRail, and its mobile
          top bar is rendered inside the grid branch below, restricted to
          `md:hidden`. Attract renders full-screen and gets no top bar. */}
      {view !== 'attract' && view !== 'grid' && <KioskTopBar roster={roster} clock={clock} />}

      {view === 'grid' && (
        <div className="flex flex-1 flex-col md:flex-row">
          <KioskRail roster={roster} clock={clock} />
          {/* md:pt-8: the mobile top bar right below (which supplies its own
              top padding via KioskTopBar's pt-5) is hidden at this
              breakpoint, so the panel needs its own top spacing to avoid
              butting the greeting straight against the viewport edge. */}
          <div className="flex flex-1 flex-col md:pt-8">
            <KioskTopBar roster={roster} clock={clock} className="md:hidden" />
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
          </div>
        </div>
      )}

      {view === 'attract' && (
        <AttractView startIndex={attractEntryCount} onExit={exitAttract} />
      )}

      {view === 'splash' && splash && (
        <SplashView
          info={splash}
          undoing={undoing}
          onUndo={() => performUndo(splash.attendanceId)}
          onDismiss={resetToGrid}
          adSrc={dailyAdSrc}
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
        <h1 className="mt-6 font-display text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
          {roster?.greeting ?? 'Welcome'}
        </h1>
        {/* md:text-lg: a one-step bump on the iPad kiosk (see the
            member-card / search-input sizing comments below for the same
            treatment) — least-technical-user legibility pass. */}
        <p className="mt-1.5 text-neutral-500 dark:text-neutral-400 md:text-lg">
          Tap your name below to check in
        </p>

        <div className="mt-6">
          <input
            type="search"
            inputMode="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type your name to find it faster"
            aria-label="Search your name"
            className="min-h-[56px] w-full rounded-2xl border border-neutral-200 bg-white px-5 text-base text-neutral-900 shadow-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-50 dark:placeholder:text-neutral-500 dark:focus:border-neutral-600 md:text-lg"
          />
        </div>

        {rosterError && (
          <div className="mt-8 rounded-2xl bg-white p-8 text-center text-neutral-500 shadow-sm dark:bg-neutral-900 dark:text-neutral-400">
            <p>Can&apos;t reach the roster — check the connection</p>
            <p className="mt-1">Ask a member for help.</p>
          </div>
        )}

        {!rosterError && roster && (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
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

        {/* A Unicode non-breaking space (not a plain space) sits between
            "Welcome" and the arrow below — measured live at 375px width
            now that Button's primary variant renders font-display
            font-bold (see components/ui/button.tsx): this line wraps at
            that width, and a plain space let the browser strand the
            arrow alone on its own second line. The non-breaking space
            keeps "Welcome →" as one unbreakable unit, so it wraps as a
            whole phrase ("First time here?" / "Welcome →") instead of
            orphaning a lone glyph. */}
        <Button variant="primary" size="lg" fullWidth onClick={onOpenVisitorForm} className="mt-10">
          First time here? Welcome{' '}→
        </Button>

        {/* md+: this content already lives at the bottom of KioskRail
            (RailAmplyFooter) — only render it here below md, where the rail
            itself is hidden. */}
        <div className="md:hidden">
          <AmplyFooter />
        </div>
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
      // opacity-80 while pending: a slow venue wifi request must FEEL
      // alive, not just spin silently — this plus the "One moment…" swap
      // below give a tapped card a visible in-flight state instead of just
      // disabling with no other feedback.
      className={`flex min-h-[64px] flex-col items-center gap-2 rounded-2xl bg-white p-4 text-center shadow-sm transition active:scale-[0.98] disabled:active:scale-100 dark:bg-neutral-900 ${
        pending ? 'opacity-80' : ''
      }`}
    >
      <span
        className={`flex h-14 w-14 items-center justify-center rounded-full text-lg font-semibold ${
          checkedIn
            ? 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400'
            : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
        }`}
      >
        {checkedIn ? <CheckMark className="h-6 w-6" /> : getInitials(name)}
      </span>
      {/* text-base md:text-lg — up from text-sm, part of the iPad-kiosk
          legibility pass; line-clamp-1 (unchanged) keeps a single line
          regardless of size, so the bump can't push a card taller than its
          neighbors — verified against the longest roster name, "Anthony
          Gillette". */}
      <span className="line-clamp-1 text-base font-medium text-neutral-900 dark:text-neutral-50 md:text-lg">
        {name}
      </span>
      {checkedIn ? (
        // text-xs, deliberately NOT bumped alongside the industry line
        // below — measured live: at text-sm this wraps to two lines on a
        // narrow mobile card ("Checked in · 9:34" / "PM"), making
        // checked-in cards taller than their neighbors. line-clamp-1 is a
        // belt-and-suspenders truncation guard in case a future longer
        // "checked in by" phrasing runs long even at this size.
        //
        // green-700 (not the -600 used above for the avatar) — at this text
        // size this label needs the darker shade to clear WCAG AA 4.5:1 in
        // light mode; the dark-mode pairing (green-400 on a near-black
        // page) was already compliant, so it's untouched.
        <span className="line-clamp-1 text-xs font-medium text-green-700 dark:text-green-400">
          Checked in · {formatTime(member.checkedInAt!)}
        </span>
      ) : pending ? (
        <span className="line-clamp-1 text-sm text-neutral-500 dark:text-neutral-400">One moment…</span>
      ) : (
        member.industry && (
          // text-sm, up from text-xs — same legibility pass as the name
          // above; verified against the longest roster industry, "Business
          // consulting".
          <span className="line-clamp-1 text-sm text-neutral-500 dark:text-neutral-400">{member.industry}</span>
        )
      )}
    </button>
  );
}

// ---- Splash view ----------------------------------------------------------

function SplashView({
  info, undoing, onUndo, onDismiss, adSrc,
}: {
  info: SplashInfo;
  undoing: boolean;
  onUndo: () => void;
  onDismiss: () => void;
  adSrc: string;
}) {
  // React's `autoFocus` prop only triggers an implicit .focus() call for a
  // hardcoded set of host elements (button/input/select/textarea) — it's a
  // no-op on arbitrary elements like h1. So the heading needs a real
  // ref + mount effect instead, verified live (activeElement now lands on
  // the h1, not <body>).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    // Tap-anywhere-to-continue: the whole splash dismisses on click/Enter/
    // Escape (the undo Button stops propagation so undoing never also
    // dismisses-and-races). The auto-return timer still runs as a fallback.
    <main
      onClick={onDismiss}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') onDismiss(); }}
      className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 text-center"
    >
      {/* Day's ad as a full-bleed backdrop, darkened with a scrim underneath
          so the confirmation text stays legible regardless of the theme or
          what's in the photo — see dayOfYear()'s comment for the selection
          logic. This makes the surface ALWAYS effectively dark, which is why
          every color below is a fixed value rather than a light/dark: pair:
          Tailwind's dark: variant tracks the OS theme, not "is my local
          background dark right now," so a normal dark: pairing would render
          the light-mode (WCAG-failing-on-dark) color whenever the OS theme
          happens to be light, regardless of this scrim. */}
      <Image src={adSrc} alt="" fill priority sizes="100vw" className="object-cover" />
      <div className="absolute inset-0 bg-black/75" />

      {/* Wrapped in one `relative` container rather than adding `relative`
          to each child: position:absolute content (the image and scrim
          above) paints above static in-flow content in the same stacking
          context regardless of DOM order (CSS 2.1 Appendix E) — so without
          this, the backdrop would cover the confirmation text. */}
      <div className="relative flex flex-col items-center">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-green-900/40">
          <CheckMark className="h-12 w-12 text-green-400" />
        </div>
        {/* tabIndex + ref-focus: this heading is the whole point of the
            splash screen, so it (not just the body) gets focus — screen
            readers on a shared kiosk announce "You're in, {name}"
            immediately rather than silently landing on <body>. outline-none
            because this is a programmatic focus-on-mount, not a keyboard tab
            stop; there's nothing to show a focus ring in response to. */}
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-6 font-display text-3xl font-bold tracking-tight text-white outline-none sm:text-4xl"
        >
          You&apos;re in, {firstNameOf(info.fullName)}
        </h1>
        {/* text-neutral-200, not -400/-500 — measured live against the
            scrim+ad composite to clear 4.5:1 (worst-case white-pixel
            backdrop still composites to ~rgb(64,64,64), and neutral-400
            would fall short of 4.5:1 there; -200 clears it with margin). */}
        <p className="mt-2 text-neutral-200">
          Checked in at {formatTime(info.checkedInAt)}
        </p>
        {/* Confirmation-strength line for the least-technical-user lens —
            spells out that there's nothing left to do, in plain warm
            language rather than a cute tagline. Same text-neutral-200 as
            the line above (already measured to clear 4.5:1 against the
            scrim+ad composite, see that comment), just smaller. */}
        <p className="mt-1 text-sm text-neutral-200">
          You can put the iPad down — you&apos;re done.
        </p>
        {/* !text-[#F0595F]: overrides Button's ghost/brand tone, which
            normally pairs text-[#CF2030] (light) with dark:text-[#F0595F] —
            here too, that pairing would show the WCAG-failing CF2030
            whenever the OS theme is light, since dark: doesn't know this
            particular surface is always dark. Forced to the dark-safe value
            unconditionally instead; `!` because a same-specificity
            non-important override isn't reliably ordered ahead of the
            component's own class in Tailwind's generated stylesheet (see
            components/ui/button.tsx's docblock). */}
        {/* Solid backing chip: contrast is computed against the chip surface,
            not the rotating ad photo behind it — photo-independent AA
            (#F0595F on neutral-950 ≈ 6.0:1) and future-proof against new
            creatives. */}
        <Button
          variant="ghost"
          tone="brand"
          size="touch"
          onClick={(e) => { e.stopPropagation(); onUndo(); }}
          disabled={undoing}
          className="mt-6 !text-[#F0595F] !bg-neutral-950/90 rounded-xl !px-5"
        >
          Not you? Undo
        </Button>
        <p className="mt-4 text-sm text-neutral-300">Tap anywhere to continue</p>
      </div>
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
            <h1 className="font-display text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
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
            <Button
              variant="ghost"
              tone="neutral"
              size="touch"
              fullWidth
              onClick={onNotThatPerson}
              disabled={submitting}
              className="mt-6"
            >
              No — I&apos;m new here
            </Button>
          </div>
        ) : (
          <form
            className="mt-4"
            onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
          >
            <h1 className="font-display text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
              Welcome — tell us about you
            </h1>

            {error && (
              // text-base, not text-sm — least-technical-user lens: an
              // error message is exactly the wrong place to shrink text.
              <div
                style={{ color: BRAND_RED }}
                className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-base dark:bg-red-950/40"
              >
                {error}
              </div>
            )}

            <div className="mt-6 flex flex-col gap-4">
              <Field label="Full name">
                <input
                  type="text"
                  required
                  minLength={2}
                  autoFocus
                  value={form.fullName}
                  onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
                  style={error && !nameValid ? VISITOR_INPUT_ERROR_STYLE : undefined}
                  className={VISITOR_INPUT_CLASS}
                />
              </Field>
              <Field label="Industry">
                <input
                  type="text"
                  required
                  minLength={2}
                  value={form.industry}
                  onChange={(e) => setForm((f) => ({ ...f, industry: e.target.value }))}
                  style={error && !industryValid ? VISITOR_INPUT_ERROR_STYLE : undefined}
                  className={VISITOR_INPUT_CLASS}
                />
              </Field>
              <Field label="Company (optional)">
                <input
                  type="text"
                  value={form.company}
                  onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                  className={VISITOR_INPUT_CLASS}
                />
              </Field>
              <Field label="Work email">
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  style={error && !emailValid ? VISITOR_INPUT_ERROR_STYLE : undefined}
                  className={VISITOR_INPUT_CLASS}
                />
              </Field>
              <Field label="Phone (optional)">
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  className={VISITOR_INPUT_CLASS}
                />
              </Field>
            </div>

            <Button type="submit" variant="primary" size="lg" fullWidth disabled={submitting} className="mt-8">
              {submitting ? 'Checking in…' : 'Check in'}
            </Button>

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

        <h1 className="mt-4 font-display text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
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
          className="mt-6 min-h-[56px] w-full rounded-2xl border border-neutral-200 bg-white px-5 text-base text-neutral-900 shadow-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-50 dark:placeholder:text-neutral-500 dark:focus:border-neutral-600 md:text-lg"
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
