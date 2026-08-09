import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { people, meetings, attendance } from '@/db/schema';

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
});
