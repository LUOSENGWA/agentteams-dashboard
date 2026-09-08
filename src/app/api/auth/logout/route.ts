// POST /api/auth/logout - Clear the dashboard session (M19).
//
// Also clears the Higress Console cookie (_hi_sess) when present, so a full
// logout leaves no stale credentials in the browser.
import { NextResponse } from 'next/server';
import { clearSessionCookieHeader, parseCookies } from '@/lib/dashboard-session';

const HIGRESS_SESSION_COOKIE = '_hi_sess';

export async function POST(request: Request) {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  headers.append('set-cookie', clearSessionCookieHeader());

  const cookies = parseCookies(request.headers.get('cookie'));
  if (cookies[HIGRESS_SESSION_COOKIE]) {
    headers.append('set-cookie', `${HIGRESS_SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  }

  return new NextResponse(JSON.stringify({ success: true }), { status: 200, headers });
}
