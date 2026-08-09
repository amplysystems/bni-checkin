import { auth } from '@/auth';

// Belt-and-suspenders: proxy.ts already gates /api/admin/* at the edge, but
// each admin route handler must independently verify auth() too — tests call
// handlers directly (bypassing the proxy), and defense-in-depth means a future
// route added outside the matcher still fails closed.
export async function requireAdmin(): Promise<{ email: string } | Response> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return { email };
}
