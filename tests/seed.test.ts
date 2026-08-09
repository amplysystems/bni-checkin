import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { people, memberships } from '@/db/schema';

describe('seed', () => {
  it('is idempotent — running twice creates exactly 12 people', async () => {
    const db = await createTestDb();
    await seed(db);
    await seed(db);
    const rows = await db.select().from(people);
    expect(rows).toHaveLength(12);
  });

  it('heals a partially failed run — person without membership gets one on re-run', async () => {
    const db = await createTestDb();
    await db.insert(people).values({ fullName: 'Mike Anderson', industry: 'Divorce attorney', company: null });

    await seed(db);

    const rows = await db.select().from(people);
    expect(rows).toHaveLength(12);

    const [mike] = await db.select().from(people).where(eq(people.fullName, 'Mike Anderson'));
    const openMemberships = await db.select().from(memberships).where(eq(memberships.personId, mike.id));
    expect(openMemberships).toHaveLength(1);
    expect(openMemberships[0].endedAt).toBeNull();
  });
});
