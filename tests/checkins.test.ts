import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { people, meetings, attendance, settings, memberships } from '@/db/schema';
import { checkIn, voidCheckIn, kioskRoster, grantExtraVisit, CheckInError } from '@/lib/checkins';
import { getOrCreateMeetingFor } from '@/lib/meetings';
import { seed } from '../scripts/seed';

describe('attendance schema constraints', () => {
  let db: TestDb;
  let personId: string;
  let meetingId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const [p] = await db.insert(people).values({ fullName: 'Test Person' }).returning();
    const [m] = await db.insert(meetings).values({
      meetingDate: '2026-08-12', startsAt: new Date('2026-08-12T20:30:00Z'),
    }).returning();
    personId = p.id;
    meetingId = m.id;
  });

  it('rejects a second active check-in for the same person and meeting', async () => {
    await db.insert(attendance).values({ personId, meetingId, kind: 'member', checkedInBy: 'kiosk' });
    await expect(
      db.insert(attendance).values({ personId, meetingId, kind: 'member', checkedInBy: 'kiosk' }),
    ).rejects.toThrow();
  });

  it('allows re-check-in after the first was voided', async () => {
    const [first] = await db.insert(attendance)
      .values({ personId, meetingId, kind: 'member', checkedInBy: 'kiosk' }).returning();
    const { eq } = await import('drizzle-orm');
    await db.update(attendance)
      .set({ voidedAt: new Date(), voidedBy: 'kiosk' })
      .where(eq(attendance.id, first.id));
    const [second] = await db.insert(attendance)
      .values({ personId, meetingId, kind: 'member', checkedInBy: 'kiosk' }).returning();
    expect(second.id).not.toBe(first.id);
  });

  it('rejects a reused client_op_id even after the original was voided', async () => {
    const [first] = await db.insert(attendance)
      .values({ personId, meetingId, kind: 'member', checkedInBy: 'kiosk', clientOpId: 'op-x' })
      .returning();
    await db.update(attendance)
      .set({ voidedAt: new Date(), voidedBy: 'kiosk' })
      .where(eq(attendance.id, first.id));
    await expect(
      db.insert(attendance)
        .values({ personId, meetingId, kind: 'member', checkedInBy: 'kiosk', clientOpId: 'op-x' }),
    ).rejects.toThrow();
  });

  it('rejects a second meeting on the same meeting_date', async () => {
    await expect(
      db.insert(meetings).values({
        meetingDate: '2026-08-12', startsAt: new Date('2026-08-12T21:00:00Z'),
      }),
    ).rejects.toThrow();
  });

  it('rejects a second settings row (singleton check constraint)', async () => {
    await db.insert(settings).values({ id: 1 });
    await expect(db.insert(settings).values({ id: 2 })).rejects.toThrow();
  });

  it('rejects a second open membership for the same person', async () => {
    await db.insert(memberships).values({ personId, status: 'visitor' });
    await expect(
      db.insert(memberships).values({ personId, status: 'member' }),
    ).rejects.toThrow();

    const [openMembership] = await db.select().from(memberships).where(eq(memberships.personId, personId));
    await db.update(memberships)
      .set({ endedAt: new Date() })
      .where(eq(memberships.id, openMembership.id));

    const [second] = await db.insert(memberships)
      .values({ personId, status: 'member' }).returning();
    expect(second.id).not.toBe(openMembership.id);
  });
});

describe('checkIn', () => {
  let db: TestDb;
  const NOW = new Date('2026-08-12T19:00:00Z');

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
  });

  async function personByName(name: string) {
    const { eq } = await import('drizzle-orm');
    const [p] = await db.select().from(people).where(eq(people.fullName, name));
    return p;
  }

  it('checks a member in with kind=member', async () => {
    const jason = await personByName('Jason Barrios');
    const r = await checkIn(db, { personId: jason.id, clientOpId: 'op-1', source: 'kiosk', now: NOW });
    expect(r.deduped).toBe(false);
    expect(r.attendance.kind).toBe('member');
  });

  it('replaying the same clientOpId is a no-op returning the original row', async () => {
    const jason = await personByName('Jason Barrios');
    const a = await checkIn(db, { personId: jason.id, clientOpId: 'op-1', source: 'kiosk', now: NOW });
    const b = await checkIn(db, { personId: jason.id, clientOpId: 'op-1', source: 'kiosk', now: NOW });
    expect(b.deduped).toBe(true);
    expect(b.attendance.id).toBe(a.attendance.id);
  });

  it('a second tap with a NEW opId still cannot double-check-in', async () => {
    const jason = await personByName('Jason Barrios');
    const a = await checkIn(db, { personId: jason.id, clientOpId: 'op-1', source: 'kiosk', now: NOW });
    const b = await checkIn(db, { personId: jason.id, clientOpId: 'op-2', source: 'kiosk', now: NOW });
    expect(b.deduped).toBe(true);
    expect(b.attendance.id).toBe(a.attendance.id);
  });

  it('void then re-check-in creates a new row and keeps the voided one', async () => {
    const jason = await personByName('Jason Barrios');
    const a = await checkIn(db, { personId: jason.id, clientOpId: 'op-1', source: 'kiosk', now: NOW });
    await voidCheckIn(db, { attendanceId: a.attendance.id, by: 'kiosk' });
    const b = await checkIn(db, { personId: jason.id, clientOpId: 'op-3', source: 'kiosk', now: NOW });
    expect(b.attendance.id).not.toBe(a.attendance.id);
    const all = await db.select().from(attendance);
    expect(all).toHaveLength(2);
  });

  it('leadership checks in with kind=leadership', async () => {
    const carey = await personByName('Carey Rothbardt');
    const r = await checkIn(db, { personId: carey.id, clientOpId: 'op-4', source: 'kiosk', now: NOW });
    expect(r.attendance.kind).toBe('leadership');
  });

  it('kioskRoster returns members with checked-in state and no leadership/visitors in the grid', async () => {
    const jason = await personByName('Jason Barrios');
    await checkIn(db, { personId: jason.id, clientOpId: 'op-5', source: 'kiosk', now: NOW });
    const roster = await kioskRoster(db, NOW);
    expect(roster.members).toHaveLength(10);
    const j = roster.members.find((m) => m.fullName === 'Jason Barrios')!;
    expect(j.checkedInAt).toBeTruthy();
    expect(roster.members.map((m) => m.fullName)).not.toContain('Carey Rothbardt');
  });

  it('kioskRoster returns leadership with checked-in state, excluded from members', async () => {
    const carey = await personByName('Carey Rothbardt');
    await checkIn(db, { personId: carey.id, clientOpId: 'op-6', source: 'kiosk', now: NOW });
    const roster = await kioskRoster(db, NOW);

    expect(roster.leadership.map((l) => l.fullName)).toEqual(['Carey Rothbardt', 'Marisa']);
    const c = roster.leadership.find((l) => l.fullName === 'Carey Rothbardt')!;
    expect(c.checkedInAt).toBeTruthy();
    const marisa = roster.leadership.find((l) => l.fullName === 'Marisa')!;
    expect(marisa.checkedInAt).toBeNull();

    expect(roster.members).toHaveLength(10);
    expect(roster.members.map((m) => m.fullName)).not.toContain('Carey Rothbardt');
    expect(roster.members.map((m) => m.fullName)).not.toContain('Marisa');
  });

  it('numbers visitor visits, excluding voided ones, per meeting date', async () => {
    const [visitor] = await db.insert(people).values({ fullName: 'Val Visitor' }).returning();
    await db.insert(memberships).values({ personId: visitor.id, status: 'visitor' });

    const first = await checkIn(db, { personId: visitor.id, clientOpId: 'v-1', source: 'kiosk', now: NOW });
    expect(first.attendance.visitNumber).toBe(1);

    await voidCheckIn(db, { attendanceId: first.attendance.id, by: 'kiosk' });

    // Same meeting date, new opId: the voided visit is excluded from the count.
    const second = await checkIn(db, { personId: visitor.id, clientOpId: 'v-2', source: 'kiosk', now: NOW });
    expect(second.attendance.visitNumber).toBe(1);

    // A different meeting a week later: the non-voided visit above now counts.
    const laterMeeting = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
    const third = await checkIn(
      db, { personId: visitor.id, clientOpId: 'v-3', source: 'kiosk', now: laterMeeting },
    );
    expect(third.attendance.visitNumber).toBe(2);
  });

  it('replaying a voided opId reports voided:true and creates no new row', async () => {
    const jason = await personByName('Jason Barrios');
    const a = await checkIn(db, { personId: jason.id, clientOpId: 'op-1', source: 'kiosk', now: NOW });
    await voidCheckIn(db, { attendanceId: a.attendance.id, by: 'kiosk' });

    const b = await checkIn(db, { personId: jason.id, clientOpId: 'op-1', source: 'kiosk', now: NOW });
    expect(b.deduped).toBe(true);
    expect(b.voided).toBe(true);
    expect(b.attendance.id).toBe(a.attendance.id);

    const all = await db.select().from(attendance);
    expect(all).toHaveLength(1);
  });

  it('rejects check-in for an unknown personId with CheckInError(person_not_found)', async () => {
    const err = await checkIn(
      db, { personId: '00000000-0000-0000-0000-000000000000', clientOpId: 'x-1', source: 'kiosk', now: NOW },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CheckInError);
    expect((err as CheckInError).code).toBe('person_not_found');
  });

  it('rejects check-in for a deactivated person with CheckInError(person_deactivated)', async () => {
    const jason = await personByName('Jason Barrios');
    await db.update(people).set({ deactivatedAt: new Date() }).where(eq(people.id, jason.id));

    const err = await checkIn(
      db, { personId: jason.id, clientOpId: 'x-2', source: 'kiosk', now: NOW },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CheckInError);
    expect((err as CheckInError).code).toBe('person_deactivated');
  });

  it('rejects a replayed clientOpId claimed by a different personId with CheckInError(op_conflict)', async () => {
    const jason = await personByName('Jason Barrios');
    const mike = await personByName('Mike Anderson');
    await checkIn(db, { personId: jason.id, clientOpId: 'shared-op', source: 'kiosk', now: NOW });

    const err = await checkIn(
      db, { personId: mike.id, clientOpId: 'shared-op', source: 'kiosk', now: NOW },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CheckInError);
    expect((err as CheckInError).code).toBe('op_conflict');
  });

  it('voidCheckIn scoped to a meetingId only voids that meeting\'s attendance row', async () => {
    const jason = await personByName('Jason Barrios');
    const a = await checkIn(db, { personId: jason.id, clientOpId: 'scope-1', source: 'kiosk', now: NOW });
    const meeting = await getOrCreateMeetingFor(db, NOW);
    const otherMeeting = await getOrCreateMeetingFor(db, new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000));

    const wrongScope = await voidCheckIn(
      db, { attendanceId: a.attendance.id, by: 'kiosk', meetingId: otherMeeting.id },
    );
    expect(wrongScope).toBeNull();

    const rightScope = await voidCheckIn(
      db, { attendanceId: a.attendance.id, by: 'kiosk', meetingId: meeting.id },
    );
    expect(rightScope).not.toBeNull();
    expect(rightScope!.voidedAt).toBeTruthy();
  });
});

// Phase 2 Task 6 two-visit kiosk rule.
describe('checkIn — two-visit kiosk rule', () => {
  let db: TestDb;
  const WEEK1 = new Date('2026-08-12T19:00:00Z');
  const WEEK2 = new Date(WEEK1.getTime() + 7 * 24 * 60 * 60 * 1000);
  const WEEK3 = new Date(WEEK1.getTime() + 14 * 24 * 60 * 60 * 1000);
  const WEEK4 = new Date(WEEK1.getTime() + 21 * 24 * 60 * 60 * 1000);

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
  });

  async function newVisitor(name: string) {
    const [p] = await db.insert(people).values({ fullName: name }).returning();
    await db.insert(memberships).values({ personId: p.id, status: 'visitor' });
    return p;
  }

  async function personByName(name: string) {
    const [p] = await db.select().from(people).where(eq(people.fullName, name));
    return p;
  }

  it('visit 1 and visit 2 check in normally', async () => {
    const v = await newVisitor('Two Visit Val');
    const first = await checkIn(db, { personId: v.id, clientOpId: 'tv-1', source: 'kiosk', now: WEEK1 });
    expect(first.attendance.visitNumber).toBe(1);
    const second = await checkIn(db, { personId: v.id, clientOpId: 'tv-2', source: 'kiosk', now: WEEK2 });
    expect(second.attendance.visitNumber).toBe(2);
  });

  it('the 3rd attempt is refused with CheckInError(visit_limit) and records no attendance row', async () => {
    const v = await newVisitor('Three Time Tina');
    await checkIn(db, { personId: v.id, clientOpId: 'tt-1', source: 'kiosk', now: WEEK1 });
    await checkIn(db, { personId: v.id, clientOpId: 'tt-2', source: 'kiosk', now: WEEK2 });

    const err = await checkIn(
      db, { personId: v.id, clientOpId: 'tt-3', source: 'kiosk', now: WEEK3 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CheckInError);
    expect((err as CheckInError).code).toBe('visit_limit');

    const rows = await db.select().from(attendance).where(eq(attendance.personId, v.id));
    expect(rows).toHaveLength(2); // only the two real visits — the refused 3rd attempt wrote nothing
  });

  it('admin override (grantExtraVisit) allows exactly one extra visit, then re-refuses', async () => {
    const v = await newVisitor('Override Owen');
    await checkIn(db, { personId: v.id, clientOpId: 'oo-1', source: 'kiosk', now: WEEK1 });
    await checkIn(db, { personId: v.id, clientOpId: 'oo-2', source: 'kiosk', now: WEEK2 });

    const blocked = await checkIn(
      db, { personId: v.id, clientOpId: 'oo-3', source: 'kiosk', now: WEEK3 },
    ).catch((e) => e);
    expect((blocked as CheckInError).code).toBe('visit_limit');

    const granted = await grantExtraVisit(db, v.id);
    expect(granted).toBe(true);
    let [person] = await db.select().from(people).where(eq(people.id, v.id));
    expect(person.allowExtraVisit).toBe(true);

    const third = await checkIn(db, { personId: v.id, clientOpId: 'oo-4', source: 'kiosk', now: WEEK3 });
    expect(third.attendance.visitNumber).toBe(3);

    // The override is consumed (single-use) — it was reset back to false.
    [person] = await db.select().from(people).where(eq(people.id, v.id));
    expect(person.allowExtraVisit).toBe(false);

    // A 4th attempt, with no fresh override, is refused again.
    const fourth = await checkIn(
      db, { personId: v.id, clientOpId: 'oo-5', source: 'kiosk', now: WEEK4 },
    ).catch((e) => e);
    expect((fourth as CheckInError).code).toBe('visit_limit');
  });

  it('members and leadership are NEVER refused, no matter how many meetings they attend', async () => {
    const jason = await personByName('Jason Barrios');
    const carey = await personByName('Carey Rothbardt');
    const weeks = [WEEK1, WEEK2, WEEK3, WEEK4];
    for (let i = 0; i < weeks.length; i += 1) {
      const m = await checkIn(db, { personId: jason.id, clientOpId: `member-week-${i}`, source: 'kiosk', now: weeks[i] });
      expect(m.attendance.kind).toBe('member');
      const l = await checkIn(db, { personId: carey.id, clientOpId: `leader-week-${i}`, source: 'kiosk', now: weeks[i] });
      expect(l.attendance.kind).toBe('leadership');
    }
  });

  it('a voided visit is excluded from the count toward the limit, same as visitNumber numbering', async () => {
    const v = await newVisitor('Voided Vic');
    const first = await checkIn(db, { personId: v.id, clientOpId: 'vv-1', source: 'kiosk', now: WEEK1 });
    await voidCheckIn(db, { attendanceId: first.attendance.id, by: 'kiosk' });
    // Voided week-1 visit doesn't count — this is still "visit 1".
    const second = await checkIn(db, { personId: v.id, clientOpId: 'vv-2', source: 'kiosk', now: WEEK2 });
    expect(second.attendance.visitNumber).toBe(1);
    const third = await checkIn(db, { personId: v.id, clientOpId: 'vv-3', source: 'kiosk', now: WEEK3 });
    expect(third.attendance.visitNumber).toBe(2);
    const fourth = await checkIn(
      db, { personId: v.id, clientOpId: 'vv-4', source: 'kiosk', now: WEEK4 },
    ).catch((e) => e);
    expect((fourth as CheckInError).code).toBe('visit_limit');
  });

  it('grantExtraVisit on an unknown personId returns false', async () => {
    const granted = await grantExtraVisit(db, '00000000-0000-0000-0000-000000000000');
    expect(granted).toBe(false);
  });
});
