import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { people, meetings, attendance, settings, memberships } from '@/db/schema';

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
