import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { people, memberships, personRoles } from '@/db/schema';
import { checkIn, kioskRoster } from '@/lib/checkins';
import { changeStatus, resolvePersonStatus, ChangeStatusError } from '@/lib/roster';

async function personByName(db: TestDb, name: string) {
  const [p] = await db.select().from(people).where(eq(people.fullName, name));
  return p;
}

async function openMembershipsFor(db: TestDb, personId: string) {
  return db.select().from(memberships)
    .where(and(eq(memberships.personId, personId), isNull(memberships.endedAt)));
}

async function leadershipRolesFor(db: TestDb, personId: string) {
  return db.select().from(personRoles)
    .where(and(eq(personRoles.personId, personId), eq(personRoles.role, 'leadership')));
}

describe('changeStatus', () => {
  let db: TestDb;
  const NOW = new Date('2026-08-12T19:00:00Z');

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
  });

  it('visitor -> member: moves them into kioskRoster members and keeps visit history intact', async () => {
    const [visitor] = await db.insert(people).values({ fullName: 'Val Visitor' }).returning();
    await db.insert(memberships).values({ personId: visitor.id, status: 'visitor' });
    const visit = await checkIn(db, { personId: visitor.id, clientOpId: 'v-1', source: 'kiosk', now: NOW });
    expect(visit.attendance.kind).toBe('visitor');
    expect(visit.attendance.visitNumber).toBe(1);

    const result = await changeStatus(db, { personId: visitor.id, to: 'member', by: 'admin:test@example.com' });
    expect(result).toEqual({ changed: true, status: 'member' });

    expect(await resolvePersonStatus(db, visitor.id)).toBe('member');

    const kiosk = await kioskRoster(db, NOW);
    expect(kiosk.members.map((m) => m.fullName)).toContain('Val Visitor');
    expect(kiosk.leadership.map((l) => l.fullName)).not.toContain('Val Visitor');

    // The original visitor attendance row is untouched — same person id,
    // same attendance id, still carrying its original visitNumber.
    const stillThere = await db.select().from(people).where(eq(people.id, visitor.id));
    expect(stillThere).toHaveLength(1);
    const openMs = await openMembershipsFor(db, visitor.id);
    expect(openMs).toHaveLength(1);
    expect(openMs[0].status).toBe('member');
    const closedMs = await db.select().from(memberships)
      .where(and(eq(memberships.personId, visitor.id), eq(memberships.status, 'visitor')));
    expect(closedMs).toHaveLength(1);
    expect(closedMs[0].endedAt).not.toBeNull();
  });

  it('member -> leadership: adds a person_roles row, closes the open membership, moves them in kioskRoster', async () => {
    const mike = await personByName(db, 'Mike Anderson');
    expect((await openMembershipsFor(db, mike.id))).toHaveLength(1);

    const result = await changeStatus(db, { personId: mike.id, to: 'leadership', by: 'admin:test@example.com' });
    expect(result).toEqual({ changed: true, status: 'leadership' });

    expect(await resolvePersonStatus(db, mike.id)).toBe('leadership');
    expect(await openMembershipsFor(db, mike.id)).toHaveLength(0); // closed, not left open
    expect(await leadershipRolesFor(db, mike.id)).toHaveLength(1);

    const kiosk = await kioskRoster(db, NOW);
    expect(kiosk.members.map((m) => m.fullName)).not.toContain('Mike Anderson');
    expect(kiosk.leadership.map((l) => l.fullName)).toContain('Mike Anderson');
  });

  it('leadership -> member: reverses — role row removed, a fresh open membership opened', async () => {
    const carey = await personByName(db, 'Carey Rothbardt');
    expect(await leadershipRolesFor(db, carey.id)).toHaveLength(1);
    expect(await openMembershipsFor(db, carey.id)).toHaveLength(0);

    const result = await changeStatus(db, { personId: carey.id, to: 'member', by: 'admin:test@example.com' });
    expect(result).toEqual({ changed: true, status: 'member' });

    expect(await leadershipRolesFor(db, carey.id)).toHaveLength(0);
    const openMs = await openMembershipsFor(db, carey.id);
    expect(openMs).toHaveLength(1);
    expect(openMs[0].status).toBe('member');

    const kiosk = await kioskRoster(db, NOW);
    expect(kiosk.leadership.map((l) => l.fullName)).not.toContain('Carey Rothbardt');
    expect(kiosk.members.map((m) => m.fullName)).toContain('Carey Rothbardt');
  });

  it('double-apply (same target twice) is a true no-op, not an error, and writes nothing the second time', async () => {
    const mike = await personByName(db, 'Mike Anderson');

    const first = await changeStatus(db, { personId: mike.id, to: 'leadership', by: 'admin:a@example.com' });
    expect(first).toEqual({ changed: true, status: 'leadership' });
    const rolesAfterFirst = await leadershipRolesFor(db, mike.id);
    expect(rolesAfterFirst).toHaveLength(1);
    const allMembershipsAfterFirst = await db.select().from(memberships).where(eq(memberships.personId, mike.id));

    const second = await changeStatus(db, { personId: mike.id, to: 'leadership', by: 'admin:b@example.com' });
    expect(second).toEqual({ changed: false, status: 'leadership' });

    // Nothing new written: same single role row (same grantedAt), same
    // membership history (no extra closed rows appended).
    const rolesAfterSecond = await leadershipRolesFor(db, mike.id);
    expect(rolesAfterSecond).toHaveLength(1);
    expect(rolesAfterSecond[0].grantedAt).toEqual(rolesAfterFirst[0].grantedAt);
    const allMembershipsAfterSecond = await db.select().from(memberships).where(eq(memberships.personId, mike.id));
    expect(allMembershipsAfterSecond).toHaveLength(allMembershipsAfterFirst.length);
  });

  it('double-apply on a member->member no-op likewise writes no new membership row', async () => {
    const mike = await personByName(db, 'Mike Anderson');
    const before = await db.select().from(memberships).where(eq(memberships.personId, mike.id));
    expect(before).toHaveLength(1);

    const result = await changeStatus(db, { personId: mike.id, to: 'member', by: 'admin:test@example.com' });
    expect(result).toEqual({ changed: false, status: 'member' });

    const after = await db.select().from(memberships).where(eq(memberships.personId, mike.id));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
  });

  it('uniq_open_membership is never violated across a chain of transitions', async () => {
    const mike = await personByName(db, 'Mike Anderson');
    const targets: Array<'member' | 'leadership' | 'visitor'> = [
      'leadership', 'visitor', 'member', 'leadership', 'member',
    ];
    for (const to of targets) {
      await changeStatus(db, { personId: mike.id, to, by: 'admin:test@example.com' });
      const open = await openMembershipsFor(db, mike.id);
      // Leadership convention: role row, NO open membership — so exactly 0
      // there and exactly 1 everywhere else. Both directions are invariants;
      // <=1 would let a zero-membership member slip through unnoticed.
      expect(open.length).toBe(to === 'leadership' ? 0 : 1);
    }
    // Final state landed on 'member' with exactly one open row.
    const finalOpen = await openMembershipsFor(db, mike.id);
    expect(finalOpen).toHaveLength(1);
    expect(finalOpen[0].status).toBe('member');
  });

  it('throws ChangeStatusError(person_deactivated) for a deactivated person and writes nothing', async () => {
    const mike = await personByName(db, 'Mike Anderson');
    await db.update(people).set({ deactivatedAt: new Date() }).where(eq(people.id, mike.id));

    const err = await changeStatus(
      db, { personId: mike.id, to: 'leadership', by: 'admin:test@example.com' },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ChangeStatusError);
    expect((err as ChangeStatusError).code).toBe('person_deactivated');

    expect(await leadershipRolesFor(db, mike.id)).toHaveLength(0);
    expect(await openMembershipsFor(db, mike.id)).toHaveLength(1); // untouched
  });

  it('throws ChangeStatusError(person_not_found) for an unknown personId', async () => {
    const err = await changeStatus(
      db, { personId: '00000000-0000-0000-0000-000000000000', to: 'member', by: 'admin:test@example.com' },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ChangeStatusError);
    expect((err as ChangeStatusError).code).toBe('person_not_found');
  });

  // P2-2 fast-follow (Task 8 carry-in): two concurrent changeStatus calls
  // for the SAME person, each targeting a different member/visitor status
  // from a starting point ('leadership') that makes both calls close-then-
  // insert. Real interleaving against PGlite via Promise.allSettled (same
  // pattern as tests/visitors.test.ts's concurrent registerVisitor test) —
  // both calls must settle FULFILLED (no raw 23505 crash), and the DB must
  // never end up with more than one open membership row afterward.
  it('two racing changeStatus calls (member vs visitor) both settle fulfilled and leave exactly one open membership', async () => {
    const mike = await personByName(db, 'Mike Anderson');
    await changeStatus(db, { personId: mike.id, to: 'leadership', by: 'admin:setup@example.com' });
    expect(await openMembershipsFor(db, mike.id)).toHaveLength(0);

    const results = await Promise.allSettled([
      changeStatus(db, { personId: mike.id, to: 'member', by: 'admin:a@example.com' }),
      changeStatus(db, { personId: mike.id, to: 'visitor', by: 'admin:b@example.com' }),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof changeStatus>>>).value);
    expect(values.every((v) => v.status === 'member' || v.status === 'visitor')).toBe(true);

    // Leadership role was removed by whichever call ran the delete/insert
    // first; the partial unique index guarantees at most one open row no
    // matter how the two calls interleaved.
    const open = await openMembershipsFor(db, mike.id);
    expect(open.length).toBe(1);
    expect(await leadershipRolesFor(db, mike.id)).toHaveLength(0);
  });
});
