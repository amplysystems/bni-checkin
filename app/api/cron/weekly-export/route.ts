// Internal cron endpoint — triggered by netlify/functions/weekly-export.mts
// on its schedule ('0 3 * * 0'). Same secret/guard convention as
// /api/cron/email-tick; the actual work is lib/emails/export.ts's
// runWeeklyExport.
import { getDb } from '@/lib/db';
import { requireCronSecret } from '@/lib/cron-guard';
import { runWeeklyExport } from '@/lib/emails/export';

export async function POST(req: Request) {
  const guard = requireCronSecret(req);
  if (guard instanceof Response) return guard;

  const result = await runWeeklyExport(getDb(), new Date());
  return Response.json(result);
}
