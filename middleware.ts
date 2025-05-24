import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { isDevelopmentEnvironment } from './lib/constants';

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  /* Health-check for Playwright */
  if (pathname.startsWith('/ping')) {
    return new Response('pong', { status: 200 });
  }

  /* Let NextAuth’s own routes through */
  if (pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  /* Current session (JWT) */
  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  /* ──────────────────────────────────────────────
     1.  NO SESSION
     ─> allow /login & /register
     ─> otherwise redirect to /login
  ─────────────────────────────────────────────── */
  if (!token) {
    if (pathname === '/login' || pathname === '/register') {
      return NextResponse.next();                // stay on the page
    }
    const dest = encodeURIComponent(`${pathname}${search}`);
    return NextResponse.redirect(
      new URL(`/login?callbackUrl=${dest}`, request.url),
    );
  }

  /* ──────────────────────────────────────────────
     2.  HAS SESSION
     ─> block /login & /register
  ─────────────────────────────────────────────── */
  if (pathname === '/login' || pathname === '/register') {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

/* Routes to run the middleware on */
export const config = {
  matcher: [
    // Only run middleware on pages that do NOT match:
    // static files, public assets, known safe paths
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|logo.svg|logo-dark.svg).*)',
  ],
};
