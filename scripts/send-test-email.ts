// One-off test send of the visitor thank-you template. Usage:
//   tsx scripts/send-test-email.ts recipient@example.com
// Uses AUTH_RESEND_KEY + EMAIL_FROM from .env.local. Note: until the
// amplysystems.com domain is verified in Resend, Resend only delivers to the
// address that owns the Resend account, from onboarding@resend.dev.
import { existsSync } from 'node:fs';
import { Resend } from 'resend';
import { visitorThankyouHtml, visitorThankyouSubject, visitorThankyouText } from '../emails/visitor-thankyou';

async function main() {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const to = process.argv[2];
  if (!to) throw new Error('usage: tsx scripts/send-test-email.ts recipient@example.com');
  const resend = new Resend(process.env.AUTH_RESEND_KEY);
  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM ?? 'onboarding@resend.dev',
    to,
    subject: `[TEST] ${visitorThankyouSubject('Dana')}`,
    html: visitorThankyouHtml({ firstName: 'Dana', siteUrl: 'https://bni-checkin-wheeling.netlify.app' }),
    text: visitorThankyouText({ firstName: 'Dana' }),
    replyTo: 'jason@amplysystems.com',
  });
  if (error) {
    console.error('SEND FAILED:', JSON.stringify(error));
    process.exit(1);
  }
  console.log('Sent, id:', data?.id);
}
main();
