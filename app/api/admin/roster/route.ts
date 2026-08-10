import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { people, memberships, personRoles, attendance } from '@/db/schema';
import { requireAdmin } from '@/lib/admin-guard';
import { changeStatus, ChangeStatusError } from '@/lib/roster';
import { grantExtraVisit } from '@/lib/checkins';

// req is optional so every existing test call site that invokes GET() with
// no arguments keeps working — only the new ?includeDeactivated=1 path needs
// a real Request to read query params from. Next.js itself always passes one.
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const db = getDb();
  const includeDeactivated = new URL(req.url).searchParams.get('includeDeactivated') === '1';
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

  // Phase 2 Task 6: total non-voided visitor-kind visits per person, across
  // every meeting (not just today's) — what the roster's "Allow another
  // visit" quiet action (app/admin/admin-client.tsx) gates on showing at
  // all. allowExtraVisit itself needs no separate query; it rides along on
  // `p` already (a real people column, see db/schema.ts).
  const visitorAttendanceRows = await db.select({ personId: attendance.personId }).from(attendance)
    .where(and(eq(attendance.kind, 'visitor'), isNull(attendance.voidedAt)));
  const visitCountByPerson = new Map<string, number>();
  for (const r of visitorAttendanceRows) {
    visitCountByPerson.set(r.personId, (visitCountByPerson.get(r.personId) ?? 0) + 1);
  }

  const peopleWithStatus = rows.map((p) => ({
    ...p,
    status: leaderIds.has(p.id) ? 'leadership' : statusByPerson.get(p.id) ?? 'none',
    visitCount: visitCountByPerson.get(p.id) ?? 0,
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
  z.object({
    action: z.literal('changeStatus'),
    personId: z.string().uuid(),
    to: z.enum(['member', 'leadership', 'visitor']),
  }),
  z.object({ action: z.literal('allowExtraVisit'), personId: z.string().uuid() }),
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

  if (d.action === 'changeStatus') {
    // Same 400-for-domain-error convention as the checkIn/CheckInError
    // pairing in app/api/admin/attendance/route.ts (only there does an
    // error code get its own status — op_conflict -> 409 — everything else,
    // including person_not_found, is 400). No case here needs a
    // different status, so both ChangeStatusError codes map to 400.
    try {
      const result = await changeStatus(db, { personId: d.personId, to: d.to, by: `admin:${guard.email}` });
      return Response.json({ status: result.status, changed: result.changed });
    } catch (e) {
      if (e instanceof ChangeStatusError) {
        return Response.json({ error: e.code }, { status: 400 });
      }
      throw e;
    }
  }

  // Phase 2 Task 6 admin override: arms the one-time "allow one more visit"
  // flag lib/checkins.ts's checkIn() consumes on that visitor's next
  // check-in attempt. Idempotent to repeat-clicking (grantExtraVisit just
  // sets the column true again) — the roster UI itself only offers this
  // action to visitors already at/over the limit, but the route doesn't
  // re-derive and enforce that same gating (see grantExtraVisit's comment).
  if (d.action === 'allowExtraVisit') {
    const granted = await grantExtraVisit(db, d.personId);
    if (!granted) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({ granted: true });
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
