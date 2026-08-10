// Netlify Scheduled Function — Sundays 03:00 UTC, once a week (spec §12
// backup/DR export). Same thin-trigger shape and dependency-free rationale
// as email-cron.mts (see its header comment) — deliberately not sharing
// code between the two .mts files: each is bundled and deployed as an
// independent function, so a tiny bit of duplication here buys isolation
// (one function's bundle/behavior can never accidentally regress the
// other's) over a shared helper that would need its own import path
// resolved correctly under Netlify's function bundler.
export const config = { schedule: '0 3 * * 0' };

function targetOrigin(): string {
  const origin = process.env.URL ?? process.env.AUTH_URL ?? 'http://localhost:3000';
  return origin.replace(/\/$/, '');
}

const handler = async () => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('weekly-export: CRON_SECRET is not set — skipping export');
    return new Response('CRON_SECRET not set', { status: 500 });
  }

  const res = await fetch(`${targetOrigin()}/api/cron/weekly-export`, {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  });
  const body = await res.text();
  if (!res.ok) console.error(`weekly-export: export route returned ${res.status}: ${body}`);
  return new Response(body, { status: res.status });
};

export default handler;
