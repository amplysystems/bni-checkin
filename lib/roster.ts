import { and, eq, isNull } from 'drizzle-orm';
import { memberships, people, personRoles } from '@/db/schema';
import type { Db } from '@/lib/db';

export type StatusTarget = 'member' | 'leadership' | 'visitor';
export type DerivedStatus = StatusTarget | 'former_member' | 'none';

export class ChangeStatusError extends Error {
  constructor(public code: 'person_not_found' | 'person_deactivated') { super(code); }
}

// Same precedence as lib/checkins.ts's resolveKind and the admin roster GET
// route's derivation (app/api/admin/roster/route.ts): leadership
// (person_roles) wins over an open membership's status, which wins over
// 'none' (no role, no open membership — e.g. a former member whose row was
// closed with nothing opened after it).
export async function resolvePersonStatus(db: Db, personId: string): Promise<DerivedStatus> {
  const roles = await db.select().from(personRoles)
    .where(and(eq(personRoles.personId, personId), eq(personRoles.role, 'leadership')));
  if (roles.length > 0) return 'leadership';
  const [openMembership] = await db.select().from(memberships)
    .where(and(eq(memberships.personId, personId), isNull(memberships.endedAt)));
  return (openMembership?.status as DerivedStatus | undefined) ?? 'none';
}

export type ChangeStatusInput = { personId: string; to: StatusTarget; by: string };
export type ChangeStatusResult = { changed: boolean; status: StatusTarget };

// Append-only membership transitions, with leadership as the plan's one
// documented non-append exception: leadership is a person_roles row (grant/
// revoke in place), never an open membership row (matches the seed
// convention in scripts/seed.ts — leadership people get a person_roles row
// and NO membership row).
//
// Idempotent-safe under uniq_open_membership (memberships.personId WHERE
// ended_at IS NULL): every path that opens a new membership row closes
// whatever is currently open FIRST, as its own statement, before the
// insert — never a single upsert, and never wrapped in db.transaction()
// (throws at runtime on the neon-http driver; see lib/db.ts). A close and
// an insert racing the same person can each only close what's open at the
// moment they run and then attempt their own insert; the partial unique
// index rejects a second concurrent open row outright (23505) rather than
// silently corrupting state — acceptable for this rare, admin-only path.
//
// Re-applying the same target status is a true no-op: resolvePersonStatus
// is checked first, and if the person is already at `to`, nothing is
// written (no redundant membership row, no touch to person_roles). This
// keeps "click it twice" (double-submit, a duplicated admin tap) harmless
// rather than merely non-erroring.
export async function changeStatus(db: Db, { personId, to, by }: ChangeStatusInput): Promise<ChangeStatusResult> {
  const [person] = await db.select().from(people).where(eq(people.id, personId));
  if (!person) throw new ChangeStatusError('person_not_found');
  if (person.deactivatedAt) throw new ChangeStatusError('person_deactivated');

  const current = await resolvePersonStatus(db, personId);
  if (current === to) {
    return { changed: false, status: to };
  }

  // Close any open membership — a harmless no-op update (0 rows) when the
  // person is currently 'leadership' or 'none' and has nothing open.
  await db.update(memberships)
    .set({ endedAt: new Date() })
    .where(and(eq(memberships.personId, personId), isNull(memberships.endedAt)));

  if (to === 'leadership') {
    // onConflictDoNothing: person_roles' PK is (personId, role), so a race
    // against another caller granting the same role lands as a harmless
    // no-op instead of a 23505 the caller would otherwise have to handle.
    await db.insert(personRoles).values({ personId, role: 'leadership' }).onConflictDoNothing();
  } else {
    // Leaving leadership (only meaningful when `current` was 'leadership';
    // a harmless no-op delete otherwise) removes the role row outright
    // rather than closing/appending it — person_roles has no ended-at/
    // history column to append against, which is exactly why this is the
    // plan's one documented non-append exception.
    await db.delete(personRoles)
      .where(and(eq(personRoles.personId, personId), eq(personRoles.role, 'leadership')));
    await db.insert(memberships).values({ personId, status: to });
  }

  // No dedicated audit table for this transition (out of scope for this
  // task — see the roster route's existing gap on attendance's
  // checkedInBy-style audit convention, which this deliberately mirrors
  // rather than invents a new mechanism for). console.log is the closest
  // existing precedent (app/api/admin/rate-limits/route.ts logs nothing
  // either; this is a new, intentionally minimal log line for now).
  console.log(`changeStatus: ${personId} ${current} -> ${to} (by ${by})`);
  return { changed: true, status: to };
}
