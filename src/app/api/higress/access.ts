import { NextRequest, NextResponse } from 'next/server';
import { validateHigressCookieString, validateHigressSession } from '@/lib/api-auth';
import { getSessionFromRequest } from '@/lib/dashboard-session';
import { getHigressConsoleURL } from './proxy-helper';

export async function requireHigressConsoleAccess(request: NextRequest): Promise<NextResponse | null> {
  try {
    getHigressConsoleURL();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Higress Console deployment configuration error';
    return NextResponse.json({ error: message }, { status: 503 });
  }

  const { valid } = await validateHigressSession(request);
  if (valid) return null;

  // 12.16: L1 data-plane sessions (Matrix track + admin-account verification)
  // carry a SERVER-BOUND Console session captured at login (never forwarded
  // to the browser) — accept it so the operator's own login can manage the
  // model gateway without switching to the admin account.
  const session = getSessionFromRequest(request);
  if (session?.consoleCookie) {
    const bound = await validateHigressCookieString(session.consoleCookie);
    if (bound.valid) return null;
  }

  return NextResponse.json({ error: 'A valid Higress Console session is required' }, { status: 401 });
}

export const requireHigressConsoleWriteAccess = requireHigressConsoleAccess;
