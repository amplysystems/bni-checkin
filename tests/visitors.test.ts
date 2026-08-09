import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { registerVisitor, suggestMatches, returningSearch } from '@/lib/visitors';
import { checkIn } from '@/lib/checkins';
import { people } from '@/db/schema';

const NOW = new Date('2026-08-12T19:00:00Z');
const NEXT_WEEK = new Date('2026-08-19T19:00:00Z');

describe('visitor flow', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
  });

  it('registers a new visitor and checks them in as visit 1', async () => {
    const r = await registerVisitor(db, {
      fullName: 'Dana Whitfield', industry: 'Commercial insurance', company: 'Whitfield Group',
      email: 'dana@whitfieldgroup.com', phone: null, clientOpId: 'v-1', now: NOW,
    });
    expect(r.attendance.kind).toBe('visitor');
    expect(r.attendance.visitNumber).toBe(1);
  });

  it('a returning visitor checking in next week is visit 2', async () => {
    const r1 = await registerVisitor(db, {
      fullName: 'Rob Feldman', industry: 'Landscaping', company: null,
      email: 'rob@feldmanlawn.com', phone: null, clientOpId: 'v-2', now: NOW,
    });
    const r2 = await checkIn(db, { personId: r1.person.id, clientOpId: 'v-3', source: 'kiosk', now: NEXT_WEEK });
    expect(r2.attendance.visitNumber).toBe(2);
  });

  it('same email does NOT silently merge — suggestMatches surfaces the candidate instead', async () => {
    await registerVisitor(db, {
      fullName: 'Pat One', industry: 'IT', company: 'Info Co',
      email: 'info@company.com', phone: null, clientOpId: 'v-4', now: NOW,
    });
    const suggestions = await suggestMatches(db, { email: 'INFO@company.com', fullName: 'Pat Two' });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].fullName).toBe('Pat One');
    const r = await registerVisitor(db, {
      fullName: 'Pat Two', industry: 'Design', company: 'Other Co',
      email: 'info@company.com', phone: null, clientOpId: 'v-5', now: NOW,
    });
    const all = await db.select().from(people);
    expect(all.filter((p) => p.email === 'info@company.com').length).toBe(2);
    expect(r.person.fullName).toBe('Pat Two');
  });

  it('suggestions never include contact info fields', async () => {
    await registerVisitor(db, {
      fullName: 'Dana Whitfield', industry: 'Commercial insurance', company: null,
      email: 'dana@whitfieldgroup.com', phone: '312-555-1111', clientOpId: 'v-6', now: NOW,
    });
    const s = await suggestMatches(db, { email: 'dana@whitfieldgroup.com', fullName: 'Dana W' });
    expect(JSON.stringify(s)).not.toContain('dana@whitfieldgroup.com');
    expect(JSON.stringify(s)).not.toContain('312-555-1111');
  });

  it('returningSearch finds past visitors by partial name, never members', async () => {
    await registerVisitor(db, {
      fullName: 'Dana Whitfield', industry: 'Commercial insurance', company: null,
      email: 'dana@whitfieldgroup.com', phone: null, clientOpId: 'v-7', now: NOW,
    });
    const hits = await returningSearch(db, 'dana');
    expect(hits).toHaveLength(1);
    const memberHits = await returningSearch(db, 'jason');
    expect(memberHits).toHaveLength(0);
  });

  it('registerVisitor is idempotent on clientOpId replay — no duplicate person/membership', async () => {
    const r1 = await registerVisitor(db, {
      fullName: 'Terry Newman', industry: 'Roofing', company: 'Newman Roofing',
      email: 'terry@newmanroofing.com', phone: null, clientOpId: 'v-8', now: NOW,
    });
    const r2 = await registerVisitor(db, {
      fullName: 'Terry Newman', industry: 'Roofing', company: 'Newman Roofing',
      email: 'terry@newmanroofing.com', phone: null, clientOpId: 'v-8', now: NOW,
    });
    expect(r2.person.id).toBe(r1.person.id);
    expect(r2.attendance.id).toBe(r1.attendance.id);
    expect(r2.deduped).toBe(true);
    const all = await db.select().from(people);
    expect(all.filter((p) => p.email === 'terry@newmanroofing.com').length).toBe(1);
  });

  it('returningSearch short-circuits on short or pure-metacharacter queries', async () => {
    await registerVisitor(db, {
      fullName: 'Dana Whitfield', industry: 'Commercial insurance', company: null,
      email: 'dana@whitfieldgroup.com', phone: null, clientOpId: 'v-9', now: NOW,
    });
    await registerVisitor(db, {
      fullName: 'Rob Feldman', industry: 'Landscaping', company: null,
      email: 'rob@feldmanlawn.com', phone: null, clientOpId: 'v-10', now: NOW,
    });
    expect(await returningSearch(db, '%')).toEqual([]);
    expect(await returningSearch(db, '_')).toEqual([]);
    expect(await returningSearch(db, '')).toEqual([]);
  });

  it('suggestMatches: a query matching both email and name returns exactly one row with only public fields', async () => {
    await registerVisitor(db, {
      fullName: 'Dana Whitfield', industry: 'Commercial insurance', company: 'Whitfield Group',
      email: 'dana@whitfieldgroup.com', phone: null, clientOpId: 'v-11', now: NOW,
    });
    const s = await suggestMatches(db, { email: 'dana@whitfieldgroup.com', fullName: 'Dana Whitfield' });
    expect(s).toHaveLength(1);
    expect(Object.keys(s[0]).sort()).toEqual(['company', 'fullName', 'id', 'industry']);
  });
});
