// Netlify Scheduled Function — Wednesdays 21:00-23:45 UTC, every 15
// minutes. That window spans 4:00-6:45 PM Chicago across BOTH DST offsets
// (CDT UTC-5 in summer, CST UTC-6 in winter), per the plan; the actual
// time-gating (>=16:45 CT before drafts compile) happens Chicago-side in
// lib/emails/tick.ts, not here.
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
