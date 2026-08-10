import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTestDb, type TestDb } from './helpers/db';
import { setDb } from '@/lib/db';
import { people } from '@/db/schema';
import { getOrCreateRsvpToken } from '@/lib/emails/rsvp-tokens';
import RsvpPage from '@/app/rsvp/[token]/page';

// Server-component test: RsvpPage is an async function that returns a React
// element (JSX only happens inside the .tsx module itself, never written in
// this .ts test file) — calling it directly and rendering the result with
// renderToStaticMarkup lets this suite assert on the actual HTML without a
// browser or a real Next.js request context.

function mockFetchOk(id = 'resend-1') {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id }), text: async () => '' });
}

describe('app/rsvp/[token]/page (server component)', () => {
  let db: TestDb;
  let personId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const [p] = await db.insert(people).values({ fullName: 'Val Visitor', email: 'val@example.com' }).returning();
    personId = p.id;
    setDb(db);
    vi.stubEnv('AUTH_RESEND_KEY', 'test-key');
    vi.stubEnv('EMAIL_FROM', 'bni@amplysystems.com');
    vi.stubEnv('EMAIL_SAFE_MODE', '0');
    vi.stubGlobal('fetch', mockFetchOk());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('valid rsvp token: headline, meeting info, three calendar actions — no contact info anywhere', async () => {
    const token = await getOrCreateRsvpToken(db, { personId, purpose: 'rsvp', targetDate: '2026-08-19' });
    const el = await RsvpPage({ params: Promise.resolve({ token }) });
    const html = renderToStaticMarkup(el);

    // React encodes the apostrophe as &#x27; in rendered text, not a literal
    // ' — match loosely across that encoding rather than hardcoding it.
    expect(html).toMatch(/You(?:&#x27;|')re on the list for Wednesday, Val/);
    expect(html).toContain('Devon Bank');
    expect(html).toContain('Add with Google Calendar');
    expect(html).toContain('Add with Outlook');
    expect(html).toContain('/api/ics');
    expect(html).toContain('calendar.google.com');
    expect(html).toContain('outlook.live.com');

    // No PII beyond a first name: neither the stored email nor the full
    // (last-name-bearing) name ever reaches the markup.
    expect(html).not.toContain('val@example.com');
    expect(html).not.toContain('Visitor'); // the surname half of "Val Visitor"
  });

  it('valid interest token: the "Got it" variant, no calendar actions', async () => {
    const token = await getOrCreateRsvpToken(db, { personId, purpose: 'interest', targetDate: '2026-08-19' });
    const el = await RsvpPage({ params: Promise.resolve({ token }) });
    const html = renderToStaticMarkup(el);

    expect(html).toContain('Got it, Val');
    expect(html).toContain('Jason will reach out');
    expect(html).not.toContain('Add with Google Calendar');
    expect(html).not.toContain('Add with Outlook');
    expect(html).not.toContain('val@example.com');
  });

  it('invalid/unknown token: the friendly expired-link message, no error codes', async () => {
    const el = await RsvpPage({ params: Promise.resolve({ token: 'not-a-real-token' }) });
    const html = renderToStaticMarkup(el);
    expect(html).toContain('This link has expired');
    expect(html).toContain('ask a member for help');
    expect(html).not.toMatch(/\b[45]\d\d\b/); // no stray HTTP-status-looking codes in the copy
  });

  it('a well-formed but never-issued token also renders the friendly invalid page', async () => {
    const el = await RsvpPage({ params: Promise.resolve({ token: '11111111-2222-4333-8444-555555555555' }) });
    const html = renderToStaticMarkup(el);
    expect(html).toContain('This link has expired');
  });
});
