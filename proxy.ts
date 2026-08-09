import { auth } from '@/auth';

export const proxy = auth((req) => {
  if (req.auth) return;
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
