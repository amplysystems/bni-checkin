import { getDb } from '@/lib/db';
import { returningSearch } from '@/lib/visitors';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  if (q.trim().length < 2) return Response.json({ results: [] });
  return Response.json({ results: await returningSearch(getDb(), q) });
}
