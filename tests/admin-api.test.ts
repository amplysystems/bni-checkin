import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/auth';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { setDb } from '@/lib/db';
import { people, memberships, personRoles, rateLimits } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { checkIn, kioskRoster, voidCheckIn } from '@/lib/checkins';
import { chicagoDateString } from '@/lib/time';
import { checkRateLimit } from '@/lib/rate-limit';
import { GET as attGET, POST as attPOST } from '@/app/api/admin/attendance/route';
import { GET as rosterGET, POST as rosterPOST } from '@/app/api/admin/roster/route';
import { GET as meetingsGET } from '@/app/api/admin/meetings/route';
import { POST as rateLimitsPOST } from '@/app/api/admin/rate-limits/route';

const mockAuth = vi.mocked(auth);

const asEmail = (email: string) => mockAuth.mockResolvedValue(
  { user: { email } } as unknown as Awaited<ReturnType<typeof auth>>,
);
const asAdmin = () => asEmail('barriosj4@gmail.com');
const asAnon = () => mockAuth.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof auth>>);

function post(url: string, body: unknown) {
  return new Request(`http://admin.test${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function get(url: string) {
  return new Request(`http://admin.test${url}`);
}

type AdminPerson = {
  id: string; fullName: string; email: string | null; phone: string | null;
  industry: string | null; company: string | null; deactivatedAt: string | null;
};

describe('admin API', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    setDb(db);
    vi.stubEnv('ADMIN_ALLOWLIST', 'barriosj4@gmail.com');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects unauthenticated requests with 401', async () => {
    asAnon();
    expect((await attGET()).status).toBe(401);
    expect((await rosterGET(new Request('http://admin.test/api/admin/roster'))).status).toBe(401);
    expect((await attPOST(post('/api/admin/attendance', {}))).status).toBe(401);
    expect((await rosterPOST(post('/api/admin/roster', {}))).status).toBe(401);
  });

  it('admin can add and void attendance, and the audit trail records who', async () => {
    asAdmin();
    const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    const jason = roster.people.find((p: AdminPerson) => p.fullName === 'Jason Barrios');

    const add = await (await attPOST(post('/api/admin/attendance', {
      action: 'add', personId: jason.id,
    }))).json();
    expect(add.attendance.checkedInBy).toBe('admin:barriosj4@gmail.com');

    const voided = await (await attPOST(post('/api/admin/attendance', {
      action: 'void', attendanceId: add.attendance.id,
    }))).json();
    expect(voided.attendance.voidedBy).toBe('admin:barriosj4@gmail.com');
  });

  it('admin roster includes contact info (unlike kiosk) and edits persist', async () => {
    asAdmin();
    const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    expect(Object.keys(roster.people[0])).toEqual(
      expect.arrayContaining(['email', 'phone', 'industry', 'company']),
    );
    const gio = roster.people.find((p: AdminPerson) => p.fullName === 'Gio');
    const res = await rosterPOST(post('/api/admin/roster', {
      action: 'update', personId: gio.id, fields: { fullName: 'Giovanni Rossi' },
    }));
    expect(res.status).toBe(200);
    const after = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    expect(after.people.map((p: AdminPerson) => p.fullName)).toContain('Giovanni Rossi');
  });

  it('deactivate is a soft delete — person keeps existing in the table', async () => {
    asAdmin();
    const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    const gio = roster.people.find((p: AdminPerson) => p.fullName === 'Gio');
    await rosterPOST(post('/api/admin/roster', { action: 'deactivate', personId: gio.id }));
    const all = await db.select().from(people);
    expect(all.find((p) => p.id === gio.id)?.deactivatedAt).toBeTruthy();
  });

  it('create with default status opens a member membership and shows up in the kiosk roster', async () => {
    asAdmin();
    const res = await rosterPOST(post('/api/admin/roster', {
      action: 'create', fields: { fullName: 'New Member Test' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('member');

    const ms = await db.select().from(memberships).where(eq(memberships.personId, body.person.id));
    expect(ms).toHaveLength(1);
    expect(ms[0].status).toBe('member');
    expect(ms[0].endedAt).toBeNull();

    const kiosk = await kioskRoster(db, new Date());
    expect(kiosk.members.map((m) => m.fullName)).toContain('New Member Test');
  });

  it('create with status leadership grants a person_roles row and is absent from the kiosk roster', async () => {
    asAdmin();
    const res = await rosterPOST(post('/api/admin/roster', {
      action: 'create', fields: { fullName: 'New Leader Test' }, status: 'leadership',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('leadership');

    const roles = await db.select().from(personRoles).where(eq(personRoles.personId, body.person.id));
    expect(roles).toHaveLength(1);
    expect(roles[0].role).toBe('leadership');

    const ms = await db.select().from(memberships).where(eq(memberships.personId, body.person.id));
    expect(ms).toHaveLength(0);

    const kiosk = await kioskRoster(db, new Date());
    expect(kiosk.members.map((m) => m.fullName)).not.toContain('New Leader Test');
  });

  it('update with an empty fields object returns 400 instead of a silent no-op', async () => {
    asAdmin();
    const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    const jason = roster.people.find((p: AdminPerson) => p.fullName === 'Jason Barrios');
    const res = await rosterPOST(post('/api/admin/roster', {
      action: 'update', personId: jason.id, fields: {},
    }));
    expect(res.status).toBe(400);
  });

  it('adding attendance for an unknown personId returns 400 person_not_found', async () => {
    asAdmin();
    const res = await attPOST(post('/api/admin/attendance', {
      action: 'add', personId: '00000000-0000-0000-0000-000000000000',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('person_not_found');
  });

  it('voiding an already-voided attendance row returns 404', async () => {
    asAdmin();
    const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    const jason = roster.people.find((p: AdminPerson) => p.fullName === 'Jason Barrios');
    const add = await (await attPOST(post('/api/admin/attendance', {
      action: 'add', personId: jason.id,
    }))).json();

    const first = await attPOST(post('/api/admin/attendance', {
      action: 'void', attendanceId: add.attendance.id,
    }));
    expect(first.status).toBe(200);

    const second = await attPOST(post('/api/admin/attendance', {
      action: 'void', attendanceId: add.attendance.id,
    }));
    expect(second.status).toBe(404);
  });

  it('a session for an email no longer on the allowlist is treated as unauthenticated', async () => {
    vi.stubEnv('ADMIN_ALLOWLIST', 'barriosj4@gmail.com');
    asEmail('former@admin.com');
    const res = await rosterGET(new Request('http://admin.test/api/admin/roster'));
    expect(res.status).toBe(401);
  });

  it('reactivate clears deactivatedAt and the person reappears in roster GET', async () => {
    asAdmin();
    const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    const gio = roster.people.find((p: AdminPerson) => p.fullName === 'Gio');
    await rosterPOST(post('/api/admin/roster', { action: 'deactivate', personId: gio.id }));
    const afterDeactivate = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    expect(afterDeactivate.people.map((p: AdminPerson) => p.id)).not.toContain(gio.id);

    const reactivateRes = await rosterPOST(post('/api/admin/roster', {
      action: 'reactivate', personId: gio.id,
    }));
    expect(reactivateRes.status).toBe(200);
    const after = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    expect(after.people.map((p: AdminPerson) => p.id)).toContain(gio.id);
  });

  it('includeDeactivated=1 includes deactivated people; reactivate restores them to the default listing', async () => {
    asAdmin();
    const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    const gio = roster.people.find((p: AdminPerson) => p.fullName === 'Gio');
    await rosterPOST(post('/api/admin/roster', { action: 'deactivate', personId: gio.id }));

    const defaultListing = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    expect(defaultListing.people.map((p: AdminPerson) => p.id)).not.toContain(gio.id);

    const withDeactivated = await (await rosterGET(get('/api/admin/roster?includeDeactivated=1'))).json();
    const gioIncluded = withDeactivated.people.find((p: AdminPerson) => p.id === gio.id);
    expect(gioIncluded).toBeTruthy();
    expect(gioIncluded.deactivatedAt).toBeTruthy();

    await rosterPOST(post('/api/admin/roster', { action: 'reactivate', personId: gio.id }));
    const restored = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
    const gioRestored = restored.people.find((p: AdminPerson) => p.id === gio.id);
    expect(gioRestored).toBeTruthy();
    expect(gioRestored.deactivatedAt).toBeNull();
  });

  describe('changeStatus action (Phase 2 Task 2: status editing + membership transitions)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      asAnon();
      const res = await rosterPOST(post('/api/admin/roster', {
        action: 'changeStatus', personId: '00000000-0000-0000-0000-000000000000', to: 'member',
      }));
      expect(res.status).toBe(401);
    });

    it('visitor -> member moves them into kioskRoster members with visit history intact', async () => {
      asAdmin();
      const created = await (await rosterPOST(post('/api/admin/roster', {
        action: 'create', fields: { fullName: 'Eric Knight' }, status: 'visitor',
      }))).json();

      const change = await rosterPOST(post('/api/admin/roster', {
        action: 'changeStatus', personId: created.person.id, to: 'member',
      }));
      expect(change.status).toBe(200);
      const changeBody = await change.json();
      expect(changeBody).toEqual({ status: 'member', changed: true });

      const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
      const ericAfter = roster.people.find((p: AdminPerson) => p.id === created.person.id);
      expect(ericAfter.status).toBe('member');

      const kiosk = await kioskRoster(db, new Date());
      expect(kiosk.members.map((m) => m.fullName)).toContain('Eric Knight');

      const ms = await db.select().from(memberships).where(eq(memberships.personId, created.person.id));
      expect(ms).toHaveLength(2); // original visitor row (closed) + new member row (open)
      expect(ms.filter((m) => m.endedAt === null)).toHaveLength(1);
    });

    it('member -> leadership -> member round-trips correctly through the admin route', async () => {
      asAdmin();
      const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
      const stephanie = roster.people.find((p: AdminPerson) => p.fullName === 'Stephanie Oh');

      const toLeadership = await rosterPOST(post('/api/admin/roster', {
        action: 'changeStatus', personId: stephanie.id, to: 'leadership',
      }));
      expect(toLeadership.status).toBe(200);
      const afterLeadership = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
      expect(afterLeadership.people.find((p: AdminPerson) => p.id === stephanie.id).status).toBe('leadership');
      const roles = await db.select().from(personRoles).where(eq(personRoles.personId, stephanie.id));
      expect(roles).toHaveLength(1);
      const openMsAsLeader = await db.select().from(memberships)
        .where(eq(memberships.personId, stephanie.id));
      expect(openMsAsLeader.every((m) => m.endedAt !== null)).toBe(true); // none open

      const backToMember = await rosterPOST(post('/api/admin/roster', {
        action: 'changeStatus', personId: stephanie.id, to: 'member',
      }));
      expect(backToMember.status).toBe(200);
      const afterMember = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
      expect(afterMember.people.find((p: AdminPerson) => p.id === stephanie.id).status).toBe('member');
      const rolesAfter = await db.select().from(personRoles).where(eq(personRoles.personId, stephanie.id));
      expect(rolesAfter).toHaveLength(0);
    });

    it('double-apply changeStatus (same target twice) is a no-op, not an error', async () => {
      asAdmin();
      const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
      const jason = roster.people.find((p: AdminPerson) => p.fullName === 'Jason Barrios');

      const first = await rosterPOST(post('/api/admin/roster', {
        action: 'changeStatus', personId: jason.id, to: 'member',
      }));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ status: 'member', changed: false }); // already a member

      const second = await rosterPOST(post('/api/admin/roster', {
        action: 'changeStatus', personId: jason.id, to: 'member',
      }));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ status: 'member', changed: false });

      const ms = await db.select().from(memberships).where(eq(memberships.personId, jason.id));
      expect(ms).toHaveLength(1); // never duplicated
    });

    it('changing status of a deactivated person returns 400', async () => {
      asAdmin();
      const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
      const gio = roster.people.find((p: AdminPerson) => p.fullName === 'Gio');
      await rosterPOST(post('/api/admin/roster', { action: 'deactivate', personId: gio.id }));

      const res = await rosterPOST(post('/api/admin/roster', {
        action: 'changeStatus', personId: gio.id, to: 'leadership',
      }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('person_deactivated');
    });

    it('rejects an unknown "to" value with 400 validation error', async () => {
      asAdmin();
      const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
      const jason = roster.people.find((p: AdminPerson) => p.fullName === 'Jason Barrios');
      const res = await rosterPOST(post('/api/admin/roster', {
        action: 'changeStatus', personId: jason.id, to: 'former_member',
      }));
      expect(res.status).toBe(400);
    });
  });

  describe('meetings GET (option B "Meeting list")', () => {
    it('rejects unauthenticated requests with 401', async () => {
      asAnon();
      expect((await meetingsGET()).status).toBe(401);
    });

    it('returns reverse-chron meetings with correct counts, excludes voided attendance, and reports visitor visit numbers', async () => {
      asAdmin();
      const roster = await (await rosterGET(new Request('http://admin.test/api/admin/roster'))).json();
      const jason = roster.people.find((p: AdminPerson) => p.fullName === 'Jason Barrios');
      const mike = roster.people.find((p: AdminPerson) => p.fullName === 'Mike Anderson');
      const [visitor] = await db.insert(people).values({ fullName: 'Val Visitor' }).returning();

      // Two distinct chapter-local afternoons a week apart — well clear of
      // any midnight/DST boundary, so chicagoDateString resolves each to a
      // single, distinct civil date.
      const earlierDate = new Date(Date.UTC(2026, 6, 20, 18, 0, 0));
      const laterDate = new Date(Date.UTC(2026, 6, 27, 18, 0, 0));
      const earlierDateStr = chicagoDateString(earlierDate);
      const laterDateStr = chicagoDateString(laterDate);

      // Earlier meeting: Jason (member) checks in then gets voided — must
      // not count or appear in attendees. The visitor checks in once (1st
      // visit).
      const jasonCheckin = await checkIn(db, {
        personId: jason.id, clientOpId: 'op-jason-1', source: 'test', now: earlierDate,
      });
      await checkIn(db, {
        personId: visitor.id, clientOpId: 'op-visitor-1', source: 'test', now: earlierDate,
      });
      await voidCheckIn(db, { attendanceId: jasonCheckin.attendance.id, by: 'test' });

      // Later meeting: Mike (member) checks in; the same visitor checks in
      // again (2nd visit — visitNumber counts prior active visitor
      // attendance across all meetings, not just this one).
      await checkIn(db, { personId: mike.id, clientOpId: 'op-mike-1', source: 'test', now: laterDate });
      await checkIn(db, { personId: visitor.id, clientOpId: 'op-visitor-2', source: 'test', now: laterDate });

      const res = await meetingsGET();
      expect(res.status).toBe(200);
      const body = await res.json();

      const dates = body.meetings.map((m: { meetingDate: string }) => m.meetingDate);
      const earlierIndex = dates.indexOf(earlierDateStr);
      const laterIndex = dates.indexOf(laterDateStr);
      expect(earlierIndex).toBeGreaterThan(-1);
      expect(laterIndex).toBeGreaterThan(-1);
      expect(laterIndex).toBeLessThan(earlierIndex); // reverse-chron: later date sorts first

      type Attendee = { personId: string; fullName: string; kind: string; visitNumber: number | null };
      type MeetingListItem = {
        meetingDate: string; total: number; memberCount: number;
        leadershipCount: number; visitorCount: number; attendees: Attendee[];
      };

      const earlierMeeting = body.meetings.find((m: MeetingListItem) => m.meetingDate === earlierDateStr);
      expect(earlierMeeting.total).toBe(1); // Jason's voided row is excluded
      expect(earlierMeeting.memberCount).toBe(0);
      expect(earlierMeeting.visitorCount).toBe(1);
      expect(earlierMeeting.attendees.find((a: Attendee) => a.fullName === 'Jason Barrios')).toBeUndefined();
      const visitorAtEarlier = earlierMeeting.attendees.find((a: Attendee) => a.fullName === 'Val Visitor');
      expect(visitorAtEarlier.kind).toBe('visitor');
      expect(visitorAtEarlier.visitNumber).toBe(1);

      const laterMeeting = body.meetings.find((m: MeetingListItem) => m.meetingDate === laterDateStr);
      expect(laterMeeting.total).toBe(2);
      expect(laterMeeting.memberCount).toBe(1);
      expect(laterMeeting.visitorCount).toBe(1);
      expect(laterMeeting.attendees.find((a: Attendee) => a.fullName === 'Mike Anderson')).toBeTruthy();
      const visitorAtLater = laterMeeting.attendees.find((a: Attendee) => a.fullName === 'Val Visitor');
      expect(visitorAtLater.visitNumber).toBe(2);
    });
  });

  describe('rate-limits reset (break-glass, Task 1 security follow-up)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      asAnon();
      const res = await rateLimitsPOST(post('/api/admin/rate-limits', { action: 'reset' }));
      expect(res.status).toBe(401);
    });

    it('rejects a malformed body with 400', async () => {
      asAdmin();
      const res = await rateLimitsPOST(post('/api/admin/rate-limits', { action: 'nope' }));
      expect(res.status).toBe(400);
    });

    it('clears seeded rate_limits rows so a previously-blocked caller is allowed again', async () => {
      asAdmin();
      const now = new Date('2026-08-12T20:00:00Z');
      const opts = { ip: '9.9.9.9', route: 'visitor', limit: 1, windowMinutes: 60, now };
      expect((await checkRateLimit(db, opts)).allowed).toBe(true);
      expect((await checkRateLimit(db, opts)).allowed).toBe(false); // tripped

      const res = await rateLimitsPOST(post('/api/admin/rate-limits', { action: 'reset' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reset).toBe(true);
      expect(body.cleared).toBeGreaterThan(0);

      const remaining = await db.select().from(rateLimits);
      expect(remaining.length).toBe(0);

      expect((await checkRateLimit(db, opts)).allowed).toBe(true); // unlocked
    });
  });
});
