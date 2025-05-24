import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { isDevelopmentEnvironment } from './lib/constants';   // keep if you still use it

export async function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  /*  Allow the Playwright health-check  */
  if (pathname.startsWith('/ping')) {
    return new Response('pong', { status: 200 });
  }

  /*  Let NextAuth internal routes pass through  */
  if (pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  /*  Retrieve session (JWT)  */
  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  /*  ────────────────────────────────────────────────
      1. NO SESSION  → redirect to /login
  ─────────────────────────────────────────────────── */
  if (!token) {
    const callbackUrl = encodeURIComponent(`${pathname}${searchParams}`);
    return NextResponse.redirect(
      new URL(`/login?callbackUrl=${callbackUrl}`, request.url),
    );
  }

  /*  ────────────────────────────────────────────────
      2. HAS SESSION  → block /login & /register
  ─────────────────────────────────────────────────── */
  if (['/login', '/register'].includes(pathname)) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

/*  Protect all routes except:
    - next static assets
    - login / register (handled in logic above)
----------------------------------------------------- */
export const config = {
  matcher: [
    '/',
    '/chat/:id*',
    '/api/:path*',
    '/login',
    '/register',
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
