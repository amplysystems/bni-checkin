// Netlify Scheduled Function — Thursdays 00:00-01:45 UTC, every 15 minutes.
// Winter-window fix (review carry-in): this is Wednesday evening in
// Chicago, not Thursday — a UTC cron day boundary rolls over hours before
// the Chicago calendar day does. In CDT (summer, UTC-5) this UTC-Thursday
// range is 19:00-20:45 PM Wed local; in CST (winter, UTC-6) it's
// 18:00-19:45 PM Wed local. Both are exactly one tick (15 min) past where
// email-cron.mts's own window ends in that same offset (18:45 CDT / 17:45
// CST) — so together the two functions form one CONTIGUOUS Wednesday
// window in Chicago local time, in both DST offsets, with no gap:
//   CDT: 16:00 ---------- 18:45 | 19:00 ---------- 20:45  (email-cron.mts | this file)
//   CST: 15:00 ---------- 17:45 | 18:00 ---------- 19:45  (email-cron.mts | this file)
// This is what actually fixes the original bug (see email-cron.mts's
// header): even an admin-customized send time as late as ~19:45 CT is now
// covered, not just the spec-default 17:00/17:30 that migration 0003
// restored.
//
// Because it's still Wednesday in Chicago throughout this whole window,
// lib/emails/tick.ts's meeting lookup (which keys off the Chicago-local
// date, not the UTC one) finds the same Wednesday meeting a same-day
// email-cron.mts tick would have — see tests/emails-tick.test.ts's
// "winter window coverage" cases for the Chicago-date proof.
//
// Same thin-trigger shape, same dependency-free rationale, and same
// deliberate non-sharing of code with the other two .mts files as
// weekly-export.mts (see its header) — each function is bundled and
// deployed independently.
export const config = { schedule: '*/15 0-1 * * 4' };

function targetOrigin(): string {
  const origin = process.env.URL ?? process.env.AUTH_URL ?? 'http://localhost:3000';
  return origin.replace(/\/$/, '');
}

const handler = async () => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('email-cron-late: CRON_SECRET is not set — skipping tick');
    return new Response('CRON_SECRET not set', { status: 500 });
  }

  const res = await fetch(`${targetOrigin()}/api/cron/email-tick`, {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  });
  const body = await res.text();
  if (!res.ok) console.error(`email-cron-late: tick route returned ${res.status}: ${body}`);
  return new Response(body, { status: res.status });
};

export default handler;
