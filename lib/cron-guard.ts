// Shared guard for the internal-only cron routes (email-tick,
// weekly-export) that Netlify Scheduled Functions call over plain HTTP
// rather than importing directly — see netlify/functions/*.mts. Netlify
// Functions run as a separate deployment target from the Next.js app (via
// @netlify/plugin-nextjs), so there is no in-process call path from a
// scheduled function into app/api/*; a shared secret over HTTP is the only
// boundary available. proxy.ts's edge matcher only covers /admin and
// /api/admin (see proxy.ts), so /api/cron/* routes are NOT session-gated —
// this header check is the entire guard for them.
//
// Same "instanceof Response" short-circuit convention as
// lib/admin-guard.ts's requireAdmin.
//
// Unset CRON_SECRET fails closed with 501, not 401 — a deploy that forgot
// to configure the env var should read as "not configured" in
// logs/monitoring, distinct from "someone's guessing at credentials".
export function requireCronSecret(req: Request): true | Response {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: 'cron_secret_unset' }, { status: 501 });
  if (req.headers.get('x-cron-secret') !== secret) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return true;
}
