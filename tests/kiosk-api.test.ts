import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { setDb } from '@/lib/db';
import { people } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { GET as rosterGET } from '@/app/api/kiosk/roster/route';
import { POST as checkinPOST } from '@/app/api/kiosk/checkin/route';
import { POST as undoPOST } from '@/app/api/kiosk/undo/route';
import { POST as visitorPOST } from '@/app/api/kiosk/visitor/route';
import { GET as returningGET } from '@/app/api/kiosk/returning/route';

function post(url: string, body: unknown) {
  return new Request(`http://kiosk.test${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

type RosterMember = { id: string; fullName: string; checkedInAt: string | null; attendanceId: string | null };

describe('kiosk API', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    const all = await db.select().from(people);
    for (const p of all) {
      await db.update(people)
        .set({ email: `${p.id}@secret-contact.test`, phone: `555-000-${p.id.slice(0, 4)}` })
        .where(eq(people.id, p.id));
    }
    setDb(db);
  });

  it('roster returns members with fields but NEVER contact info', async () => {
    const res = await rosterGET();
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('Jason Barrios');
    expect(text).not.toContain('secret-contact.test');
    expect(text).not.toContain('555-000-');
  });

  it('checkin → roster shows checked in → undo → roster shows not checked in', async () => {
    const roster = await (await rosterGET()).json();
    const jason = roster.members.find((m: RosterMember) => m.fullName === 'Jason Barrios');
    const c = await (await checkinPOST(post('/api/kiosk/checkin', {
      personId: jason.id, clientOpId: 'api-op-1-padded',
    }))).json();
    expect(c.checkedIn).toBe(true);

    const after = await (await rosterGET()).json();
    const jasonAfter = after.members.find((m: RosterMember) => m.fullName === 'Jason Barrios');
    expect(jasonAfter.checkedInAt).toBeTruthy();

    const u = await undoPOST(post('/api/kiosk/undo', { attendanceId: jasonAfter.attendanceId }));
    expect(u.status).toBe(200);
    const final = await (await rosterGET()).json();
    expect(final.members.find((m: RosterMember) => m.fullName === 'Jason Barrios').checkedInAt).toBeNull();
  });

  it('visitor registration validates input and returns no contact info', async () => {
    const bad = await visitorPOST(post('/api/kiosk/visitor', { fullName: '' }));
    expect(bad.status).toBe(400);

    const ok = await visitorPOST(post('/api/kiosk/visitor', {
      fullName: 'Dana Whitfield', industry: 'Commercial insurance', company: 'Whitfield Group',
      email: 'dana@whitfieldgroup.com', phone: null, clientOpId: 'api-op-2-padded',
    }));
    expect(ok.status).toBe(200);
    const body = JSON.stringify(await ok.json());
    expect(body).not.toContain('dana@whitfieldgroup.com');
  });

  it('returning search endpoint never leaks contact info', async () => {
    await visitorPOST(post('/api/kiosk/visitor', {
      fullName: 'Rob Feldman', industry: 'Landscaping', company: null,
      email: 'rob@feldmanlawn.com', phone: '312-555-2222', clientOpId: 'api-op-3-padded',
    }));
    const res = await returningGET(new Request('http://kiosk.test/api/kiosk/returning?q=rob'));
    const body = JSON.stringify(await res.json());
    expect(body).toContain('Rob Feldman');
    expect(body).not.toContain('rob@feldmanlawn.com');
    expect(body).not.toContain('312-555-2222');
  });

  it('a voided-replay check-in responds checkedIn:false, voided:true', async () => {
    const roster = await (await rosterGET()).json();
    const jason = roster.members.find((m: RosterMember) => m.fullName === 'Jason Barrios');
    const c = await (await checkinPOST(post('/api/kiosk/checkin', {
      personId: jason.id, clientOpId: 'api-op-void-padded',
    }))).json();
    expect(c.checkedIn).toBe(true);

    await undoPOST(post('/api/kiosk/undo', { attendanceId: c.attendanceId }));

    // Replay the same clientOpId after the check-in was voided.
    const replay = await (await checkinPOST(post('/api/kiosk/checkin', {
      personId: jason.id, clientOpId: 'api-op-void-padded',
    }))).json();
    expect(replay.checkedIn).toBe(false);
    expect(replay.voided).toBe(true);
  });

  it('checkin with an unknown personId returns 400 with error: person_not_found', async () => {
    const res = await checkinPOST(post('/api/kiosk/checkin', {
      personId: '00000000-0000-0000-0000-000000000000', clientOpId: 'api-op-unknown-padded',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('person_not_found');
  });

  it('visitor suggest flow: matching email+different name returns suggestions unless confirmedNew', async () => {
    const first = await visitorPOST(post('/api/kiosk/visitor', {
      fullName: 'Dana Whitfield', industry: 'Commercial insurance', company: 'Whitfield Group',
      email: 'dana@whitfieldgroup.com', phone: null, clientOpId: 'api-op-suggest-1-padded',
    }));
    expect(first.status).toBe(200);

    const suggestRes = await visitorPOST(post('/api/kiosk/visitor', {
      fullName: 'Dana W', industry: 'Commercial insurance', company: 'Whitfield Group',
      email: 'dana@whitfieldgroup.com', phone: null, clientOpId: 'api-op-suggest-2-padded',
    }));
    expect(suggestRes.status).toBe(200);
    const suggestBody = await suggestRes.json();
    expect(Array.isArray(suggestBody.suggestions)).toBe(true);
    expect(suggestBody.suggestions.length).toBeGreaterThan(0);
    expect(suggestBody.suggestions[0].fullName).toBe('Dana Whitfield');
    const suggestText = JSON.stringify(suggestBody);
    expect(suggestText).not.toContain('dana@whitfieldgroup.com');

    const confirmedRes = await visitorPOST(post('/api/kiosk/visitor', {
      fullName: 'Dana W', industry: 'Commercial insurance', company: 'Whitfield Group',
      email: 'dana@whitfieldgroup.com', phone: null, clientOpId: 'api-op-suggest-3-padded',
      confirmedNew: true,
    }));
    expect(confirmedRes.status).toBe(200);
    const confirmedBody = await confirmedRes.json();
    expect(confirmedBody.checkedIn).toBe(true);
    expect(confirmedBody.fullName).toBe('Dana W');

    const firstBody = await first.json();
    expect(confirmedBody.personId).not.toBe(firstBody.personId);
  });
});
