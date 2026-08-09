import { auth } from '@/auth';
import { isAllowed } from '@/lib/allowlist';

// Belt-and-suspenders: proxy.ts already gates /api/admin/* at the edge, but
// each admin route handler must independently verify auth() too — tests call
// handlers directly (bypassing the proxy), and defense-in-depth means a future
// route added outside the matcher still fails closed.
//
// The allowlist is re-checked here (not just session existence) so a
// revoked admin's still-valid session cookie stops working the moment
// ADMIN_ALLOWLIST changes, rather than staying privileged until the
// session naturally expires.
export async function requireAdmin(): Promise<{ email: string } | Response> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !isAllowed(email, process.env.ADMIN_ALLOWLIST)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return { email };
}
