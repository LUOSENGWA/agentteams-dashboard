import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionFromRequest } from './lib/dashboard-session';

// Force Node.js runtime because api-auth.ts imports higress/proxy-helper which
// uses AbortController/timeout patterns that are safer under Node runtime.
export const runtime = 'nodejs';

// Public endpoints that do NOT require a Higress browser session.
// Only genuinely public endpoints (health checks, setup bootstrap) belong here.
const PUBLIC_PATHS = [
  '/api/agentteams/setup/ensure-ai',
  '/api/agentteams/setup/status',
];

const USER_NAME_HEADER = 'x-agentteams-user';
const USER_LEVEL_HEADER = 'x-agentteams-user-level';

function withUserHeaders(request: NextRequest, user: { name: string; level: number } | null): Headers {
  const headers = new Headers(request.headers);
  if (user) {
    headers.set(USER_NAME_HEADER, user.name);
    headers.set(USER_LEVEL_HEADER, String(user.level));
  } else {
    headers.delete(USER_NAME_HEADER);
    headers.delete(USER_LEVEL_HEADER);
  }
  return headers;
}

// Backward compatibility for embedded mode: old /dashboard/ URLs redirect to root
// because the dashboard is now served at "/" when NEXT_PUBLIC_BASE_PATH is empty.
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Legacy redirect
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
    const target = pathname.replace(/^\/dashboard/, '') || '/';
    const url = request.nextUrl.clone();
    url.pathname = target;
    return NextResponse.redirect(url);
  }

  // CORS preflight requests never carry credentials — let them through so
  // browsers can complete the OPTIONS handshake.
  if (request.method === 'OPTIONS') {
    return NextResponse.next();
  }

  // API auth gate: protect ALL /api/agentteams/* routes.
  // Identity = the dashboard session cookie (at_dash_sess), created by the
  // dual-track login (M19): L1 = Higress Console admin (SA credential,
  // dashboard level 3) or L2 = Matrix login (own Matrix token, level 2).
  // The Controller credential (SA or Matrix token) never leaves the server —
  // see proxy-helper: "NEVER trust browser-supplied Authorization header".
  if (pathname.startsWith('/api/agentteams/')) {
    const isPublicPath = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
    if (isPublicPath) {
      return NextResponse.next();
    }

    // Escape hatch for environments without a Higress Console in front of
    // the dashboard (local dev, hosted previews): there is no browser
    // session to validate, so the gate would 401 every request including
    // data reads. Production deployments leave this unset to keep the gate.
    // Read per-request (not module-level) so env changes apply on reload.
    // A synthetic identity is injected so server-side RBAC evaluation and
    // audit read/write attribution keep working (the audit routes reject
    // identity-less requests, which would permanently break the audit
    // viewer in local mode). Defaults to platform-admin level 3 — local
    // mode is a single-user trusted environment — and can be overridden.
    if (process.env.AGENTTEAMS_AUTH_DISABLED === 'true') {
      const localUser = {
        name: process.env.AGENTTEAMS_LOCAL_USER ?? 'local-admin',
        level: Number(process.env.AGENTTEAMS_LOCAL_USER_LEVEL ?? 3),
      };
      const headers = withUserHeaders(request, {
        name: localUser.name,
        level: Number.isFinite(localUser.level) ? localUser.level : 3,
      });
      const res = NextResponse.next({ request: { headers } });
      res.headers.set('x-agentteams-auth-mode', 'disabled');
      return res;
    }

    const session = getSessionFromRequest(request);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Forward the resolved identity downstream so route handlers (and the
    // Controller proxy) can apply server-side RBAC + audit attribution.
    // `level` is already the dashboard rbac-engine level (E5 mapping applied
    // at session creation: CRD 1→3, 2→2, 3→1).
    return NextResponse.next({
      request: { headers: withUserHeaders(request, { name: session.user, level: session.level }) },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*', '/api/agentteams/:path*'],
};
