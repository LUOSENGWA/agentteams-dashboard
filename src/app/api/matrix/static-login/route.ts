// POST /api/matrix/static-login - F7 stateless-mode Matrix login.
//
// Same m.login.password proxy as /api/matrix/login, with two deliberate
// differences:
//
// 1. allowPrivateNetwork: true. A stateless deployment's homeserver is a
//    LAN address the browser is already on (that is the point of the
//    stateless shape — no server session because the user is on-site).
//    A browser on that LAN is network-equivalent to the dashboard server,
//    so proxying a login to a private address adds no new reachability
//    (plugin config.json parity — the plugin's backend does exactly this
//    with operator-configured addresses).
//
// 2. An optional device_name (defaults to 'dashboard') so the Matrix
//    session is attributable in the user's device list; the returned
//    device_id is persisted client-side for the S4 device-revoke button.
//
// Failover semantics (plugin parity) live on the CLIENT: an auth error
// (401/403 from the homeserver) is definitive — the client stops; a
// network failure (502 here) tells the client to try the next configured
// address.
import { NextRequest, NextResponse } from 'next/server';
import {
  HomeserverValidationError,
  validateHomeserverUrl,
} from '@/lib/homeserver-allowlist';

const DEVICE_NAME = 'dashboard';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { homeserver, username, password, device_name } = body;

    if (!homeserver || !username || !password) {
      return NextResponse.json(
        { error: 'Missing required fields: homeserver, username, password' },
        { status: 400 },
      );
    }

    let parsed: URL;
    try {
      parsed = validateHomeserverUrl(homeserver, { allowPrivateNetwork: true });
    } catch (err) {
      if (err instanceof HomeserverValidationError) {
        return NextResponse.json(
          { error: err.message, reason: err.reason },
          { status: 403 },
        );
      }
      return NextResponse.json({ error: 'Invalid homeserver URL' }, { status: 400 });
    }

    const loginUrl = `${parsed.origin}/_matrix/client/v3/login`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(loginUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: username },
          password,
          initial_device_display_name: typeof device_name === 'string' && device_name ? device_name : DEVICE_NAME,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        // Auth error: DEFINITIVE (plugin failover semantics) — surface the
        // homeserver's error verbatim; the client must not walk the list.
        return NextResponse.json(
          { error: data.error || data.errmsg || 'Login failed', code: data.errcode },
          { status: res.status },
        );
      }

      return NextResponse.json(data);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    // Network failure (refused/timeout/DNS): the client walks to the next
    // configured address (502 = "this address is unreachable").
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, reason: 'unreachable' }, { status: 502 });
  }
}
