import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/auth';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { setDb } from '@/lib/db';
import { people } from '@/db/schema';
import { GET as attGET, POST as attPOST } from '@/app/api/admin/attendance/route';
import { GET as rosterGET, POST as rosterPOST } from '@/app/api/admin/roster/route';

const mockAuth = vi.mocked(auth);

const asAdmin = () => mockAuth.mockResolvedValue(
  { user: { email: 'barriosj4@gmail.com' } } as unknown as Awaited<ReturnType<typeof auth>>,
);
const asAnon = () => mockAuth.mockResolvedValue(null as unknown as Awaited<ReturnType<typeof auth>>);

function post(url: string, body: unknown) {
  return new Request(`http://admin.test${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

type AdminPerson = {
  id: string; fullName: string; email: string | null; phone: string | null;
  industry: string | null; company: string | null;
};

describe('admin API', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
    setDb(db);
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
});
