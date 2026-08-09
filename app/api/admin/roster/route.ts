import { z } from 'zod';
import { eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { people } from '@/db/schema';
import { requireAdmin } from '@/lib/admin-guard';

export async function GET() {
  const guard = await requireAdmin();
  if (guard instanceof Response) return guard;
  const rows = await getDb().select().from(people).where(isNull(people.deactivatedAt));
  return Response.json({ people: rows });
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
  z.object({ action: z.literal('create'), fields: Fields.required({ fullName: true }) }),
  z.object({ action: z.literal('deactivate'), personId: z.string().uuid() }),
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
    return Response.json({ person: row });
  }
  if (d.action === 'update') {
    const [row] = await db.update(people).set(d.fields).where(eq(people.id, d.personId)).returning();
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({ person: row });
  }
  const [row] = await db.update(people)
    .set({ deactivatedAt: new Date() }).where(eq(people.id, d.personId)).returning();
  if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json({ person: row });
}
