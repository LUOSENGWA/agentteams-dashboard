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

export async function GET(request: NextRequest) {
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
