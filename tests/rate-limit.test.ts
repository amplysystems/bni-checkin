import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers/db';
import { checkRateLimit, cleanupExpiredRateLimits, getClientIp } from '@/lib/rate-limit';
import { rateLimits } from '@/db/schema';

describe('checkRateLimit', () => {
  it('allows requests up to the limit and blocks the one after (boundary)', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-12T20:00:00Z');
    const opts = { ip: '1.2.3.4', route: 'test', limit: 3, windowMinutes: 60, now };
    expect((await checkRateLimit(db, opts)).allowed).toBe(true); // 1
    expect((await checkRateLimit(db, opts)).allowed).toBe(true); // 2
    expect((await checkRateLimit(db, opts)).allowed).toBe(true); // 3 — exactly at the limit
    const fourth = await checkRateLimit(db, opts);
    expect(fourth.allowed).toBe(false); // 4 — over the limit
    expect(fourth.count).toBe(4);
  });

  it('rolls over to a fresh window once windowMinutes elapses (injected now)', async () => {
    const db = await createTestDb();
    const base = { ip: '5.5.5.5', route: 'test', limit: 1, windowMinutes: 60 };
    const first = await checkRateLimit(db, { ...base, now: new Date('2026-08-12T20:00:00Z') });
    expect(first.allowed).toBe(true);

    // Still inside the same hour-bucket — one second before rollover.
    const stillSameWindow = await checkRateLimit(db, { ...base, now: new Date('2026-08-12T20:59:59Z') });
    expect(stillSameWindow.allowed).toBe(false);

    // The next window (top of the next hour) starts a fresh count.
    const nextWindow = await checkRateLimit(db, { ...base, now: new Date('2026-08-12T21:00:00Z') });
    expect(nextWindow.allowed).toBe(true);
  });

  it('isolates counts per IP — one IP maxing out never affects another', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-12T20:00:00Z');
    const a = { ip: '1.1.1.1', route: 'test', limit: 1, windowMinutes: 60, now };
    const b = { ip: '2.2.2.2', route: 'test', limit: 1, windowMinutes: 60, now };
    expect((await checkRateLimit(db, a)).allowed).toBe(true);
    expect((await checkRateLimit(db, a)).allowed).toBe(false);
    expect((await checkRateLimit(db, b)).allowed).toBe(true); // untouched by IP a's usage
  });

  it('isolates counts per route for the same IP', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-12T20:00:00Z');
    const ip = '9.9.9.9';
    expect((await checkRateLimit(db, { ip, route: 'checkin', limit: 1, windowMinutes: 60, now })).allowed).toBe(true);
    expect((await checkRateLimit(db, { ip, route: 'checkin', limit: 1, windowMinutes: 60, now })).allowed).toBe(false);
    expect((await checkRateLimit(db, { ip, route: 'undo', limit: 1, windowMinutes: 60, now })).allowed).toBe(true);
  });

  it('is race-tolerant: concurrent callers in the same window still land a correct serialized count', async () => {
    const db = await createTestDb();
    const now = new Date('2026-08-12T20:00:00Z');
    const opts = { ip: '7.7.7.7', route: 'test', limit: 5, windowMinutes: 60, now };
    const results = await Promise.all(Array.from({ length: 8 }, () => checkRateLimit(db, opts)));
    const counts = results.map((r) => r.count).sort((x, y) => x - y);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // no lost updates
    expect(results.filter((r) => r.allowed).length).toBe(5);
  });
});

describe('cleanupExpiredRateLimits', () => {
  it('removes only windows older than the retention cutoff', async () => {
    const db = await createTestDb();
    await checkRateLimit(db, {
      ip: '1.1.1.1', route: 'old', limit: 100, windowMinutes: 60, now: new Date('2026-08-10T00:00:00Z'),
    });
    await checkRateLimit(db, {
      ip: '1.1.1.1', route: 'new', limit: 100, windowMinutes: 60, now: new Date('2026-08-12T20:00:00Z'),
    });
    await cleanupExpiredRateLimits(db, new Date('2026-08-12T20:00:00Z'));
    const rows = await db.select().from(rateLimits);
    expect(rows.length).toBe(1);
    expect(rows[0].key).toContain(':new:');
  });
});

describe('getClientIp', () => {
  it('prefers x-nf-client-connection-ip over x-forwarded-for', () => {
    const req = new Request('http://kiosk.test/api/kiosk/checkin', {
      headers: { 'x-nf-client-connection-ip': '10.0.0.1', 'x-forwarded-for': '10.0.0.2, 10.0.0.3' },
    });
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  it('falls back to the first hop of x-forwarded-for when Netlify header is absent', () => {
    const req = new Request('http://kiosk.test/api/kiosk/checkin', {
      headers: { 'x-forwarded-for': '10.0.0.5, 10.0.0.6' },
    });
    expect(getClientIp(req)).toBe('10.0.0.5');
  });

  it('falls back to "unknown" when neither header is present', () => {
    const req = new Request('http://kiosk.test/api/kiosk/checkin');
    expect(getClientIp(req)).toBe('unknown');
  });
});
