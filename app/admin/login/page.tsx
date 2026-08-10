import { redirect } from 'next/navigation';
import Image from 'next/image';
import { signIn } from '@/auth';
import { Button } from '@/components/ui/button';

// amply-logo.png is the real brand asset (cream wordmark + blue square),
// designed to sit on a dark background — same fixed navy pill treatment as
// the kiosk footer (app/kiosk/kiosk-client.tsx's AmplyFooter), duplicated
// here rather than shared since it's two small call sites, not three (the
// bar this codebase uses for pulling something into components/ui — see
// components/ui/button.tsx's docblock).
const AMPLY_PILL_NAVY = '#0c1322';

// Shown after every submit, regardless of whether the email was actually on
// the allowlist or the send actually succeeded. Deliberately neutral: an
// admin-only tool must not let a form response reveal allowlist membership
// (a distinct "you're not invited" vs "check your email" response would be
// exactly that oracle) or leak transient provider failures (e.g. a bad
// AUTH_RESEND_KEY) to whoever is submitting the form.
const SENT_MESSAGE =
  "Check your email — if that address is invited, a sign-in link is on its way.";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-100 dark:bg-neutral-950 px-6 font-sans">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-neutral-900 p-6">
        <h1 className="mb-1 text-xl font-semibold text-neutral-900 dark:text-neutral-50">
          BNI Wheeling admin
        </h1>

        {sent === '1' ? (
          <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">{SENT_MESSAGE}</p>
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
    </main>
  );
}
