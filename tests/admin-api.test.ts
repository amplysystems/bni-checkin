import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/auth';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { setDb } from '@/lib/db';
import { people, memberships, personRoles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { kioskRoster } from '@/lib/checkins';
import { GET as attGET, POST as attPOST } from '@/app/api/admin/attendance/route';
import { GET as rosterGET, POST as rosterPOST } from '@/app/api/admin/roster/route';

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
    expect((await rosterGET()).status).toBe(401);
    expect((await attPOST(post('/api/admin/attendance', {}))).status).toBe(401);
    expect((await rosterPOST(post('/api/admin/roster', {}))).status).toBe(401);
  });

  it('admin can add and void attendance, and the audit trail records who', async () => {
    asAdmin();
    const roster = await (await rosterGET()).json();
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
    const roster = await (await rosterGET()).json();
    expect(Object.keys(roster.people[0])).toEqual(
      expect.arrayContaining(['email', 'phone', 'industry', 'company']),
    );
    const gio = roster.people.find((p: AdminPerson) => p.fullName === 'Gio');
    const res = await rosterPOST(post('/api/admin/roster', {
      action: 'update', personId: gio.id, fields: { fullName: 'Giovanni Rossi' },
    }));
    expect(res.status).toBe(200);
    const after = await (await rosterGET()).json();
    expect(after.people.map((p: AdminPerson) => p.fullName)).toContain('Giovanni Rossi');
  });

  it('deactivate is a soft delete — person keeps existing in the table', async () => {
    asAdmin();
    const roster = await (await rosterGET()).json();
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
    const roster = await (await rosterGET()).json();
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
    const roster = await (await rosterGET()).json();
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
    const res = await rosterGET();
    expect(res.status).toBe(401);
  });

  it('reactivate clears deactivatedAt and the person reappears in roster GET', async () => {
    asAdmin();
    const roster = await (await rosterGET()).json();
    const gio = roster.people.find((p: AdminPerson) => p.fullName === 'Gio');
    await rosterPOST(post('/api/admin/roster', { action: 'deactivate', personId: gio.id }));
    const afterDeactivate = await (await rosterGET()).json();
    expect(afterDeactivate.people.map((p: AdminPerson) => p.id)).not.toContain(gio.id);

    const reactivateRes = await rosterPOST(post('/api/admin/roster', {
      action: 'reactivate', personId: gio.id,
    }));
    expect(reactivateRes.status).toBe(200);
    const after = await (await rosterGET()).json();
    expect(after.people.map((p: AdminPerson) => p.id)).toContain(gio.id);
  });

  it('includeDeactivated=1 includes deactivated people; reactivate restores them to the default listing', async () => {
    asAdmin();
    const roster = await (await rosterGET()).json();
    const gio = roster.people.find((p: AdminPerson) => p.fullName === 'Gio');
    await rosterPOST(post('/api/admin/roster', { action: 'deactivate', personId: gio.id }));

    const defaultListing = await (await rosterGET()).json();
    expect(defaultListing.people.map((p: AdminPerson) => p.id)).not.toContain(gio.id);

    const withDeactivated = await (await rosterGET(get('/api/admin/roster?includeDeactivated=1'))).json();
    const gioIncluded = withDeactivated.people.find((p: AdminPerson) => p.id === gio.id);
    expect(gioIncluded).toBeTruthy();
    expect(gioIncluded.deactivatedAt).toBeTruthy();

    await rosterPOST(post('/api/admin/roster', { action: 'reactivate', personId: gio.id }));
    const restored = await (await rosterGET()).json();
    const gioRestored = restored.people.find((p: AdminPerson) => p.id === gio.id);
    expect(gioRestored).toBeTruthy();
    expect(gioRestored.deactivatedAt).toBeNull();
  });
});
