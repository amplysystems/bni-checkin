import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import Image from 'next/image';
import { signIn } from '@/auth';
import { Button } from '@/components/ui/button';
import { authConfig, siteUrl } from '@/lib/auth-config';
import { getDb } from '@/lib/db';
import { checkRateLimit, getClientIp, OTP_VERIFY_RATE_LIMIT } from '@/lib/rate-limit';
import { sessionCookieName, sessionCookieOptions, verifyOtpAndCreateSession } from '@/lib/otp';

// amply-logo.png is the real brand asset (cream wordmark + blue square),
// designed to sit on a dark background — same fixed navy pill treatment as
// the kiosk footer (app/kiosk/kiosk-client.tsx's AmplyFooter), duplicated
// here rather than shared since it's two small call sites, not three (the
// bar this codebase uses for pulling something into components/ui — see
// components/ui/button.tsx's docblock).
const AMPLY_PILL_NAVY = '#0c1322';

// Same fixed dark background as the kiosk's split rail
// (app/kiosk/kiosk-client.tsx's RAIL_NAVY) — this panel is the
// "same-language" brand rail for the login screen, always dark regardless of
// OS theme. Duplicated rather than shared for the same two-call-sites reason
// as AMPLY_PILL_NAVY above.
const RAIL_NAVY = '#0b0f19';

// Same brand-red as the kiosk (app/kiosk/kiosk-client.tsx's BRAND_RED),
// duplicated for the same reason as AMPLY_PILL_NAVY above.
const BRAND_RED = '#CF2030';

// Shown after every submit, regardless of whether the email was actually on
// the allowlist or the send actually succeeded. Deliberately neutral: an
// admin-only tool must not let a form response reveal allowlist membership
// (a distinct "you're not invited" vs "check your email" response would be
// exactly that oracle) or leak transient provider failures (e.g. a bad
// AUTH_RESEND_KEY) to whoever is submitting the form.
const SENT_MESSAGE =
  "Check your email — if that address is invited, a sign-in link is on its way.";

// Deliberately generic across every failure mode this action can hit: wrong
// code, expired code, unknown/un-allowlisted email, rate-limited — same
// reasoning as SENT_MESSAGE above (a distinct response per failure reason
// would itself be an allowlist/rate-limit oracle). "Codes last 15 minutes"
// nudges the one actually-actionable case (a stale code) without confirming
// or denying anything about the address itself.
const CODE_ERROR_MESSAGE = "That code didn't work — codes last 15 minutes. Request a fresh email.";

// Server action for the "Have a code?" form below — verifies a six-digit
// code (emailed alongside the sign-in link, see lib/otp.ts and
// emails/login-link.ts) for admins on the INSTALLED iOS/desktop PWA, which
// has its own cookie jar and can't follow the emailed magic link back into
// itself. Kept thin on purpose: parse input, rate-limit, delegate the real
// work to lib/otp.ts's verifyOtpAndCreateSession (unit-tested directly in
// tests/auth-otp.test.ts), set the cookie, redirect. Not itself unit-tested
// — repo convention (see AGENTS.md / existing action above) is no
// component/server-action tests; the pure logic it calls into is.
async function verifyCode(formData: FormData) {
  'use server';
  const email = (formData.get('email') as string | null)?.trim();
  const code = (formData.get('code') as string | null)?.trim();

  let sessionToken: string | undefined;
  let sessionExpires: Date | undefined;

  if (email && code) {
    try {
      const db = getDb();
      const ip = getClientIp({ headers: await headers() });
      const { allowed } = await checkRateLimit(db, { ip, ...OTP_VERIFY_RATE_LIMIT });
      const secret = process.env.AUTH_SECRET;
      if (allowed && secret) {
        const result = await verifyOtpAndCreateSession(db, {
          email,
          code,
          secret,
          allowlist: process.env.ADMIN_ALLOWLIST,
          sessionMaxAgeSeconds: authConfig.session.maxAge,
        });
        if (result.ok) {
          sessionToken = result.sessionToken;
          sessionExpires = result.expires;
        }
      }
    } catch {
      // Any unexpected failure (DB error, etc.) falls through to the same
      // neutral failure redirect below rather than surfacing details.
    }
  }

  if (sessionToken && sessionExpires) {
    // useSecureCookies mirrors @auth/core's own derivation
    // (`config.useSecureCookies ?? url.protocol === 'https:'`, see
    // node_modules/@auth/core/src/lib/init.ts) — based on AUTH_URL (the
    // same canonical origin siteUrl() uses to build the link-flow's
    // verification URL) rather than the incoming request, so both sign-in
    // paths always agree on whether cookies are secure.
    const useSecureCookies = new URL(siteUrl()).protocol === 'https:';
    (await cookies()).set(
      sessionCookieName(useSecureCookies),
      sessionToken,
      sessionCookieOptions(useSecureCookies, sessionExpires),
    );
    redirect('/admin');
  }

  redirect('/admin/login?codeError=1');
}

// The "Have a code?" disclosure — present in BOTH the initial and sent=1
// states (an admin on the installed app may land on either). A plain
// <details>/<summary> rather than client-side state: this page is a Server
// Component with no 'use client' boundary today, and a zero-JS disclosure
// keeps it that way. `open` is forced when a submit just failed
// (codeError=1) so the error message is visible without an extra tap.
// A second, independent <form> (own email + code inputs) rather than
// prefilling from the link form's email — this page's state is entirely
// server-action/searchParams based, there's no client state to share a
// value from.
function CodeToggle({ codeError }: { codeError?: string }) {
  return (
    <details className="mt-5 text-sm" open={codeError === '1' ? true : undefined}>
      <summary className="cursor-pointer select-none text-neutral-500 dark:text-neutral-400">
        Have a code?
      </summary>
      <div className="mt-3">
        {codeError === '1' && (
          <p className="mb-3 text-sm text-[#CF2030] dark:text-[#F0595F]">{CODE_ERROR_MESSAGE}</p>
        )}
        <form action={verifyCode}>
          <input
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            className="mb-2 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-transparent px-4 py-3 text-[15px] text-neutral-900 dark:text-neutral-100"
          />
          <input
            name="code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            placeholder="123456"
            className="mb-3 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-transparent px-4 py-3 text-[15px] tracking-[0.3em] text-neutral-900 dark:text-neutral-100"
          />
          <Button type="submit" variant="secondary" fullWidth>
            Sign in with code
          </Button>
        </form>
      </div>
    </details>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; codeError?: string }>;
}) {
  const { sent, codeError } = await searchParams;

  return (
    <main className="flex min-h-screen flex-col bg-neutral-100 dark:bg-neutral-950 font-sans md:flex-row">
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-12">
        <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-neutral-900 p-6">
          {/* Present on every breakpoint (unlike the rail below, which is
              md+ only) so the brand still shows up on a mobile admin login. */}
          <Image
            src="/bni-logo-transparent.png"
            alt="BNI"
            width={160}
            height={90}
            priority
            className="mb-4 h-8 w-auto"
          />
          <h1 className="mb-1 font-display text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
            BNI Wheeling admin
          </h1>

          {sent === '1' ? (
            <>
              <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">{SENT_MESSAGE}</p>
              {/* Post-send guidance: this state was a dead end (reported live).
                  The sign-in lands wherever the emailed link is OPENED, so
                  spell that out, and give both exits. */}
              <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
                Open the email on this device and tap the link — you&apos;ll land in the
                admin, signed in for 7 days. If you open it on your phone instead,
                the sign-in lives on your phone.
              </p>
              <div className="mt-5 flex flex-col gap-2">
                <a
                  href="/admin"
                  className="inline-flex min-h-[48px] w-full items-center justify-center rounded-xl text-sm font-medium text-white"
                  style={{ backgroundColor: '#CF2030' }}
                >
                  I clicked the link — open my admin
                </a>
                <a
                  href="/admin/login"
                  className="inline-flex min-h-[48px] w-full items-center justify-center rounded-xl border border-neutral-300 text-sm font-medium text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
                >
                  Use a different email
                </a>
              </div>
              <CodeToggle codeError={codeError} />
            </>
          ) : (
            <>
              <p className="mb-4 text-sm text-neutral-500">Enter your email for a sign-in link</p>
              <form
                action={async (formData) => {
                  'use server';
                  // SECURITY: ?callbackUrl is intentionally never read here (not
                  // from searchParams, not echoed into redirectTo) — the proxy
                  // sets it to the page the visitor originally requested, and
                  // following a caller-supplied URL after auth is an open
                  // redirect. redirectTo is always the hardcoded '/admin'.
                  const email = (formData.get('email') as string | null)?.trim();
                  try {
                    if (email) {
                      // redirect: false suppresses signIn's own navigation (which
                      // would otherwise land on Auth.js's default verify/error
                      // page — and *which* of those it picked would itself leak
                      // allowlist membership). The email send (or rejection)
                      // still happens synchronously below; we just never look at
                      // or branch on the outcome before choosing where to send
                      // the browser next.
                      await signIn('resend', { email, redirectTo: '/admin', redirect: false });
                    }
                  } catch {
                    // Provider/network failures (e.g. placeholder AUTH_RESEND_KEY
                    // in dev) are swallowed for the same reason — the
                    // confirmation below must never depend on this outcome.
                  }
                  redirect('/admin/login?sent=1');
                }}
              >
                <input
                  name="email"
                  type="email"
                  required
                  placeholder="you@example.com"
                  className="mb-3 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-transparent px-4 py-3 text-[15px] text-neutral-900 dark:text-neutral-100"
                />
                <Button type="submit" variant="primary" fullWidth>
                  Send link
                </Button>
              </form>
              <CodeToggle codeError={codeError} />
            </>
          )}
        </div>

        <footer className="flex items-center justify-center gap-2 text-sm text-neutral-400 dark:text-neutral-500">
          <span>Powered by</span>
          <span
            className="inline-flex items-center rounded-full px-3 py-1.5"
            style={{ backgroundColor: AMPLY_PILL_NAVY }}
          >
            <Image src="/amply-logo.png" alt="Amply Systems" width={45} height={16} className="h-4 w-auto" />
          </span>
        </footer>
      </div>

      {/* Brand rail — replaces the old ad-image split panel (the source
          creatives couldn't hold crisp full-bleed at this size, see
          scripts/process-ads.ts). Same-language navy rail as the kiosk's
          split-rail grid view (app/kiosk/kiosk-client.tsx's KioskRail):
          fixed dark background regardless of OS theme, BNI mark, campaign
          line, amply pill. Hidden below md, same as the panel it replaces —
          the split only makes sense once there's room for both a usable
          form and this rail. */}
      <div
        className="hidden md:flex md:w-2/5 md:flex-col md:justify-between md:px-10 md:py-10 lg:w-1/2"
        style={{ backgroundColor: RAIL_NAVY }}
      >
        {/* self-start is load-bearing: this rail is `md:flex md:flex-col`, so
            its default align-items:stretch stretches every direct child on the
            CROSS axis — width, in a column. Without it, `w-auto` loses and the
            160x90 mark is smeared across the full rail width at a fixed h-12
            (badly distorted, reported live). The amply pill below dodges this
            only because it carries an explicit `w-fit`. */}
        <Image
          src="/bni-logo-transparent.png"
          alt="BNI"
          width={160}
          height={90}
          className="h-12 w-auto self-start"
        />

        {/* text-2xl (not text-4xl) below lg: measured live at the md
            breakpoint's narrowest point (768px viewport — a real iPad-
            portrait width, and this rail is only 40% width there, md:w-2/5
            above) — text-4xl wrapped "One plumber." mid-phrase into two
            lines each ("One" / "plumber.", "One" / "lawyer.", "One of" /
            "you."), since Unbounded is noticeably wider than the Archivo
            this replaced (see app/layout.tsx). text-2xl keeps every line on
            one line through the whole md range; lg:text-5xl (unchanged)
            still fits comfortably once the rail widens to 50% at the lg
            breakpoint. font-black (900), not font-extrabold (800) — only
            700/900 are loaded for Unbounded, so 800 isn't an actual loaded
            weight. */}
        <p className="font-display text-2xl font-black leading-tight tracking-tight text-neutral-50 lg:text-5xl">
          One plumber.
          <br />
          One lawyer.
          <br />
          <span style={{ color: BRAND_RED }}>One of you.</span>
        </p>

        <span
          className="inline-flex w-fit items-center rounded-full px-3 py-1.5"
          style={{ backgroundColor: AMPLY_PILL_NAVY }}
        >
          <Image src="/amply-logo.png" alt="Amply Systems" width={45} height={16} className="h-4 w-auto" />
        </span>
      </div>
    </main>
  );
}
