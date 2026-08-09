import { z } from 'zod';
import { getDb } from '@/lib/db';
import { registerVisitor, suggestMatches } from '@/lib/visitors';

const Body = z.object({
  fullName: z.string().trim().min(2).max(200),
  industry: z.string().trim().min(2).max(200),
  company: z.string().trim().max(200).nullable().optional().default(null),
  email: z.string().trim().max(320).email(),
  phone: z.string().trim().max(50).nullable().optional().default(null),
  clientOpId: z.string().min(8).max(128),
  confirmedNew: z.boolean().optional().default(false),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });
  const db = getDb();
  const input = parsed.data;

  if (!input.confirmedNew) {
    const suggestions = await suggestMatches(db, { email: input.email, fullName: input.fullName });
    if (suggestions.length > 0) return Response.json({ suggestions }, { status: 200 });
  }

  const r = await registerVisitor(db, { ...input, company: input.company, phone: input.phone });
  return Response.json({
    checkedIn: !r.voided, personId: r.person.id, fullName: r.person.fullName,
    attendanceId: r.attendance.id, visitNumber: r.attendance.visitNumber,
  });
}
