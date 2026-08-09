import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers/db';
import { seed } from '../scripts/seed';
import { people } from '@/db/schema';

describe('seed', () => {
  it('is idempotent — running twice creates exactly 12 people', async () => {
    const db = await createTestDb();
    await seed(db);
    await seed(db);
    const rows = await db.select().from(people);
    expect(rows).toHaveLength(12);
  });
});
