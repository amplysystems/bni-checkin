// Public (unauthenticated) Resend delivery webhook — Phase 2 Task 7 / spec
// §7. Deliberately thin: the guard + signature/body verification and all DB
// writes live in lib/emails/webhook.ts (unit-tested directly there), same
// split as app/api/cron/email-tick/route.ts and lib/emails/tick.ts.
//
// No session/allowlist guard here (unlike every app/api/admin/* route) —
// this is the one route Resend itself calls, over the open internet, with
// no cookie. Its own guard is requireResendWebhookSecret + Svix signature
// verification, not requireAdmin.
import { getDb } from '@/lib/db';
import { handleResendWebhook } from '@/lib/emails/webhook';

export async function POST(req: Request) {
  return handleResendWebhook(getDb(), req);
}
