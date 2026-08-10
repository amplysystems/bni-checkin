import { z } from 'zod';
import { eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { people, memberships, personRoles } from '@/db/schema';
import { requireAdmin } from '@/lib/admin-guard';

// req is optional so every existing test call site that invokes GET() with
// no arguments keeps working — only the new ?includeDeactivated=1 path needs
// a real Request to read query params from. Next.js itself always passes one.
export async function GET(req?: Request) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const db = getDb();
  const includeDeactivated = req ? new URL(req.url).searchParams.get('includeDeactivated') === '1' : false;
  const rows = includeDeactivated
    ? await db.select().from(people)
    : await db.select().from(people).where(isNull(people.deactivatedAt));

  // status is derived, not stored on `people`: leadership (person_roles) wins
  // over an open membership's status, which wins over 'none' (no role, no
  // open membership — e.g. a former member whose row was closed out).
  const leaders = await db.select().from(personRoles).where(eq(personRoles.role, 'leadership'));
  const leaderIds = new Set(leaders.map((r) => r.personId));
  const openMemberships = await db.select().from(memberships).where(isNull(memberships.endedAt));
  const statusByPerson = new Map(openMemberships.map((m) => [m.personId, m.status]));

  const peopleWithStatus = rows.map((p) => ({
    ...p,
    status: leaderIds.has(p.id) ? 'leadership' : statusByPerson.get(p.id) ?? 'none',
  }));
  return Response.json({ people: peopleWithStatus });
}

const Fields = z.object({
  fullName: z.string().trim().min(2).max(200).optional(),
  displayName: z.string().trim().max(200).nullable().optional(),
  industry: z.string().trim().max(200).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update'), personId: z.string().uuid(), fields: Fields }),
  z.object({
    action: z.literal('create'),
    fields: Fields.required({ fullName: true }),
    status: z.enum(['member', 'leadership', 'visitor']).optional().default('member'),
  }),
  z.object({ action: z.literal('deactivate'), personId: z.string().uuid() }),
  z.object({ action: z.literal('reactivate'), personId: z.string().uuid() }),
]);

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  const db = getDb();
  const d = parsed.data;

  if (d.action === 'create') {
    const [row] = await db.insert(people).values(d.fields).returning();
    // Leadership gets a person_roles row and NO membership row, matching the
    // seed convention (see scripts/seed.ts) — leadership are not counted as
    // members in the kiosk grid. member/visitor get an open membership row
    // instead, which is what makes them show up via kioskRoster().
    if (d.status === 'leadership') {
      await db.insert(personRoles).values({ personId: row.id, role: 'leadership' });
    } else {
      await db.insert(memberships).values({ personId: row.id, status: d.status });
    }
    return Response.json({ person: row, status: d.status });
  }

  if (d.action === 'update') {
    if (Object.keys(d.fields).length === 0) {
      return Response.json({ error: 'No fields to update' }, { status: 400 });
    }
    const [row] = await db.update(people).set(d.fields).where(eq(people.id, d.personId)).returning();
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({ person: row });
  }

  if (d.action === 'reactivate') {
    const [row] = await db.update(people)
      .set({ deactivatedAt: null }).where(eq(people.id, d.personId)).returning();
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({ person: row });
  }

  const [row] = await db.update(people)
    .set({ deactivatedAt: new Date() }).where(eq(people.id, d.personId)).returning();
  if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json({ person: row });
}
