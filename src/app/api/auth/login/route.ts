// POST /api/auth/login - Dual-track multi-user authentication (M19 / batch M).
//
// Track L1 (Higress Console admin):
//   Console /session/login with the admin account (deployment assumption:
//   Console admin = the L1 human, env DASHBOARD_L1_HUMAN, default "luo").
//   Identity is resolved server-side via the admin SA: GET /humans/{L1} must
//   exist with permissionLevel 1. The session carries the SA credential —
//   the browser never receives it. The Higress Console session cookie is
//   still forwarded so the gateway tab (/api/higress/*) keeps working.
//
// Track L2 (Matrix login):
//   Server-side Matrix password login → own access token → whoami localpart →
//   SA GET /humans/{localpart} must exist with permissionLevel 2. The session
//   carries the user's Matrix token (server-side only) as the Controller
//   credential — A2 chain scopes reads to accessibleTeams (T4 field-tested).
//
// Both tracks fail → 401. Session secret missing → login fails closed
// (dashboard-session throws, logged once).
//
// External mode (AGENTTEAMS_HIGRESS_ADAPTER_MODE=external) keeps the upstream
// #76 semantics: no init, Console-only, no Matrix (remote clients must not
// receive internal homeserver tokens).

import { NextRequest, NextResponse } from 'next/server';
import { callHigressConsole, forwardCookies, getHigressConsoleURL } from '../../higress/proxy-helper';
import { getAuthToken, getControllerUrl } from '../../agentteams/proxy-helper';
import { createSession, sessionCookieHeader } from '@/lib/dashboard-session';
import { validateHomeserverUrl } from '@/lib/homeserver-allowlist';

// Server-side default follows the embedded topology: the dashboard container
// reaches Tuwunel directly inside the agentteams-controller container.
const MATRIX_HOMESERVER =
  process.env.NEXT_PUBLIC_MATRIX_API_URL ||
  process.env.AGENTTEAMS_MATRIX_URL ||
  'http://agentteams-controller:6167';

interface HumanRecord {
  name?: string;
  permissionLevel?: number;
  accessibleTeams?: string[];
  accessibleWorkers?: string[];
}

/**
 * Resolve a Human CR via the admin SA token. Returns null when the controller
 * is unreachable, the token is missing, or the human does not exist.
 */
async function fetchHumanViaSa(request: NextRequest, name: string): Promise<HumanRecord | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const res = await fetch(`${getControllerUrl(request)}/api/v1/humans/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as HumanRecord;
  } catch {
    return null;
  }
}

/**
 * Attempt Matrix login with the given credentials.
 * Returns the Matrix login result or null if it fails.
 */
async function tryMatrixLogin(username: string, password: string): Promise<Record<string, unknown> | null> {
  try {
    validateHomeserverUrl(MATRIX_HOMESERVER, { allowPrivateNetwork: true });
  } catch {
    return null; // Invalid homeserver URL, skip
  }

  try {
    const res = await fetch(`${MATRIX_HOMESERVER}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    return {
      accessToken: data.access_token,
      userId: data.user_id,
      deviceId: data.device_id,
      homeserver: MATRIX_HOMESERVER,
    };
  } catch {
    return null; // Matrix unreachable or login failed, skip silently
  }
}

export async function POST(request: NextRequest) {
  const isExternal = process.env.AGENTTEAMS_HIGRESS_ADAPTER_MODE === 'external';

  try {
    const body = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return NextResponse.json({ success: false, error: 'Username and password are required' }, { status: 400 });
    }

    // Dual track: try the Console (L1) first; on failure fall through to
    // Matrix (L2). A Console success with an unresolvable L1 identity is a
    // deployment misconfiguration — fail loudly instead of guessing.
    // External mode (upstream #76): no init, no Matrix token/URL to the
    // remote client; the server-side L1 CR lookup still applies.
    const l1 = await attemptConsoleLogin(request, username, password, { allowMatrix: !isExternal });
    if (l1.kind === 'session') {
      return l1.response;
    }
    if (l1.kind === 'misconfigured') {
      return l1.response;
    }

    return await attemptMatrixLogin(request, username, password);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Fail-closed: a missing session secret surfaces here (dashboard-session throws).
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

type ConsoleAttempt =
  | { kind: 'session'; response: NextResponse }
  | { kind: 'misconfigured'; response: NextResponse }
  | { kind: 'failed' };

/**
 * L1 track: Console admin login → SA human lookup (must be permissionLevel 1)
 * → session with the SA credential. Forwards the Console session cookie so
 * the gateway tab keeps working for L1.
 */
async function attemptConsoleLogin(
  request: NextRequest,
  username: string,
  password: string,
  opts: { allowMatrix: boolean },
): Promise<ConsoleAttempt> {
  const consoleUrl = getHigressConsoleURL();

  // NOTE: the upstream auto-initializer (/system/init, "first login auto-
  // registers a Console admin") was intentionally REMOVED. It is a privilege
  // escalation path in a multi-user deployment: a fresh Console would be
  // initialized with whoever logs in first — and in the dual-track flow a
  // failed L2 (Matrix) attempt with mistyped credentials would create a
  // Console admin that the L1 track then accepts as the L1 human. The Console
  // admin account must be provisioned out-of-band (installer / first-time
  // setup only).
  let consoleRes: Response;
  try {
    const result = await callHigressConsole('/session/login', {
      method: 'POST',
      body: { username, password },
      consoleUrl,
    });
    consoleRes = result.response;
  } catch {
    return { kind: 'failed' };
  }
  if (!consoleRes.ok) {
    return { kind: 'failed' };
  }

  // Resolve the L1 identity from the Human CRD via the admin SA.
  const l1Name = process.env.DASHBOARD_L1_HUMAN || 'luo';
  const human = await fetchHumanViaSa(request, l1Name);
  if (!human || human.permissionLevel !== 1) {
    return {
      kind: 'misconfigured',
      response: NextResponse.json(
        {
          success: false,
          error: `Console login ok, but L1 identity "${l1Name}" could not be resolved from the Controller (missing SA token or Human CR / wrong permissionLevel). Check DASHBOARD_L1_HUMAN and AGENTTEAMS_AUTH_TOKEN.`,
        },
        { status: 503 },
      ),
    };
  }

  let cookieValue: string;
  try {
    ({ cookieValue } = createSession({
      user: human.name || l1Name,
      crLevel: 1,
      teams: human.accessibleTeams ?? [],
      credential: { kind: 'sa' },
    }));
  } catch (err) {
    return {
      kind: 'misconfigured',
      response: NextResponse.json(
        { success: false, error: `Session store unavailable: ${err instanceof Error ? err.message : 'unknown'}` },
        { status: 503 },
      ),
    };
  }

  // Chat convenience: L1's own Matrix token (client-side, chat only).
  // External mode must not return an internal homeserver URL or Matrix access
  // token to the remote client (upstream #76).
  const matrix = opts.allowMatrix ? await tryMatrixLogin(username, password) : null;

  const responseHeaders = new Headers();
  responseHeaders.set('content-type', 'application/json');
  responseHeaders.set('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  // Dashboard session first, then the Higress Console cookie (gateway tab).
  responseHeaders.append('set-cookie', sessionCookieHeader(cookieValue));
  forwardCookies(consoleRes.headers, responseHeaders);

  return {
    kind: 'session',
    response: new NextResponse(
      JSON.stringify({
        success: true,
        user: { username: human.name || l1Name, level: 3 },
        mode: 'higress',
        matrix,
      }),
      { status: 200, headers: responseHeaders },
    ),
  };
}

/**
 * L2 track: Matrix password login → own access token → Human CR must be
 * permissionLevel 2 → session carrying the user's Matrix token (server-side).
 */
async function attemptMatrixLogin(request: NextRequest, username: string, password: string): Promise<NextResponse> {
  const matrix = await tryMatrixLogin(username, password);
  if (!matrix || !matrix.accessToken) {
    return NextResponse.json({ success: false, error: 'Invalid username or password' }, { status: 401 });
  }

  const userId = typeof matrix.userId === 'string' ? matrix.userId : '';
  const localpart = userId.startsWith('@') ? userId.slice(1).split(':')[0] : username;
  const human = await fetchHumanViaSa(request, localpart);
  if (!human || human.permissionLevel !== 2) {
    return NextResponse.json({ success: false, error: 'Invalid username or password' }, { status: 401 });
  }

  let cookieValue: string;
  try {
    ({ cookieValue } = createSession({
      user: human.name || localpart,
      crLevel: 2,
      teams: human.accessibleTeams ?? [],
      credential: { kind: 'matrix', token: String(matrix.accessToken) },
    }));
  } catch (err) {
    return NextResponse.json(
      { success: false, error: `Session store unavailable: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 503 },
    );
  }

  const responseHeaders = new Headers();
  responseHeaders.set('content-type', 'application/json');
  responseHeaders.set('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  responseHeaders.set('set-cookie', sessionCookieHeader(cookieValue));

  return new NextResponse(
    JSON.stringify({
      success: true,
      user: { username: human.name || localpart, level: 2 },
      mode: 'matrix',
      matrix,
    }),
    { status: 200, headers: responseHeaders },
  );
}

