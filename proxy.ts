import { auth } from '@/auth';
import { isAllowed } from '@/lib/allowlist';

export const proxy = auth((req) => {
  // A session cookie can outlive its holder's admin privileges (allowlist
  // edited after login, session not yet expired) — re-check the CURRENT
  // allowlist here too, not just that a session exists. A revoked admin
  // falls through to the same 401/redirect branches as an anonymous visitor.
  if (req.auth && isAllowed(req.auth.user?.email, process.env.ADMIN_ALLOWLIST)) return;
  const { nextUrl } = req;
  if (nextUrl.pathname.startsWith('/api/admin'))
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (nextUrl.pathname !== '/admin/login') {
    const url = new URL('/admin/login', nextUrl.origin);
    url.searchParams.set('callbackUrl', nextUrl.href);
    return Response.redirect(url);
  }
});

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
