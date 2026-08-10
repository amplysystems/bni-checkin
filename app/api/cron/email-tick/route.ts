// Internal cron endpoint — triggered by netlify/functions/email-cron.mts on
// its schedule ('*/15 21-23 * * 3'). Deliberately thin: the guard, then a
// single call into lib/emails/tick.ts's runEmailTick, which owns the actual
// orchestration (and is unit-tested directly, without going through this
// HTTP layer — see tests/emails-tick.test.ts).
import { getDb } from '@/lib/db';
import { requireCronSecret } from '@/lib/cron-guard';
import { runEmailTick } from '@/lib/emails/tick';

export async function POST(req: Request) {
  const guard = requireCronSecret(req);
  if (guard instanceof Response) return guard;

  const result = await runEmailTick(getDb(), new Date());
  return Response.json(result);
}
