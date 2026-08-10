// Netlify Scheduled Function — Wednesdays 21:00-23:45 UTC, every 15
// minutes. CORRECTION (winter-window review): this window is NOT the same
// width in Chicago local time across DST offsets — it's a fixed UTC range,
// so it covers 16:00-18:45 CDT in summer (UTC-5) but only 15:00-17:45 CST
// in winter (UTC-6), an hour earlier and an hour narrower. That's exactly
// what caused the original bug: the (wrong, pre-migration-0003) leadership
// report default of 18:00 CT fell OUTSIDE this window entirely in winter
// (18:00 CST = 00:00 UTC Thursday), so a winter report would sit
// 'scheduled' for a full 7 days until the following Wednesday's window
// reopened it. Migration 0003 fixed the defaults to spec §5's 17:00/17:30,
// which DO fit inside this window's winter tail (17:45 CST is this
// window's last tick) — but with only a 15-minute margin, any
// admin-customized send time later than that would repeat the same
// failure mode. email-cron-late.mts's Thu 00:00-01:45 UTC window is
// deliberately contiguous with this one in BOTH offsets (see that file's
// header) as the actual fix for that residual risk, not just a "just in
// case" — this window alone still isn't reliably enough on its own once
// admin-configurable times are in play. The time-gating that decides
// whether there's actually anything to do (>=16:45 CT before drafts
// compile) happens Chicago-side in lib/emails/tick.ts, not here — both
// this function and email-cron-late.mts hit the exact same idempotent
// tick route, so firing on a tick with nothing due is a no-op.
//
// This function is deliberately a thin trigger with no business logic of
// its own: Netlify Functions run in a separate deployment target from the
// Next.js app (see @netlify/plugin-nextjs), so there's no in-process call
// path into app/api/* anyway — POSTing to the app's own internal cron
// route with the shared secret is the only boundary available. All real
// logic lives in app/api/cron/email-tick/route.ts (thin) -> lib/emails/
// tick.ts (the orchestration), both unit-tested directly there.
//
// Kept dependency-free (plain fetch, no `@netlify/functions` import) per
// the task: the `config` export below doesn't need the `Config` type to
// work — Netlify reads the schedule off the exported object's shape at
// deploy time, not its TypeScript type.
export const config = { schedule: '*/15 21-23 * * 3' };

// Netlify injects URL (the site's live production origin) into every
// function's environment automatically. AUTH_URL is this app's own
// existing "canonical origin" env var (already used by lib/emails/
// constants.ts's siteUrl() and lib/auth-config.ts) — checked second so
// this function still has a sane target if URL isn't set the way it is on
// Netlify's real runtime (e.g. local `netlify dev`).
function targetOrigin(): string {
  const origin = process.env.URL ?? process.env.AUTH_URL ?? 'http://localhost:3000';
  return origin.replace(/\/$/, '');
}

const handler = async () => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('email-cron: CRON_SECRET is not set — skipping tick');
    return new Response('CRON_SECRET not set', { status: 500 });
  }

  const res = await fetch(`${targetOrigin()}/api/cron/email-tick`, {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  });
  const body = await res.text();
  if (!res.ok) console.error(`email-cron: tick route returned ${res.status}: ${body}`);
  return new Response(body, { status: res.status });
};

export default handler;
