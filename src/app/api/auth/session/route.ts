// GET /api/auth/session - Resolve the browser's dashboard session (M19).
//
// The dashboard session cookie (at_dash_sess) is created by the dual-track
// login. `username` is the Human CR name (never a Higress consumer name —
// the old /v1/consumers probe reported the first consumer, which is why the
// UI used to show "manager" for everyone). `level` is the dashboard
// rbac-engine level (3 Admin / 2 Operator / 1 Observer) used by the UI
// level gate; the security boundary remains server-side (middleware +
// Controller A2).
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/dashboard-session';
import { isStatelessAuthMode } from '@/lib/static-mode';
import { resolveStaticIdentity } from '@/lib/static-identity';

export async function GET(request: NextRequest) {
  // F7 stateless mode: no server session — resolve the identity from the
  // bearer token the client sent (the same resolver the middleware uses,
  // so the UI and the data plane agree). `reason` distinguishes "no
  // credential yet" (show the login page) from "backend unreachable"
  // (show a retryable error — the stored token may still be valid).
  if (isStatelessAuthMode()) {
    const result = await resolveStaticIdentity(request);
    if (result === null) {
      return NextResponse.json({ authenticated: false, reason: 'no-credential' }, { status: 200 });
    }
    if (result.ok === 'unreachable') {
      return NextResponse.json(
        { authenticated: false, reason: 'unreachable', detail: result.detail },
        { status: 200 },
      );
    }
    if (result.ok === 'invalid') {
      return NextResponse.json(
        { authenticated: false, reason: 'invalid', detail: result.detail },
        { status: 200 },
      );
    }
    return NextResponse.json({
      authenticated: true,
      username: result.identity.name,
      level: result.identity.level,
      teams: result.identity.teams,
      mode: 'stateless',
    }, { status: 200 });
  }

  const session = getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }

  return NextResponse.json({
    authenticated: true,
    username: session.user,
    level: session.level,
    mode: session.credential.kind === 'sa' ? 'higress' : 'matrix',
  }, { status: 200 });
}
