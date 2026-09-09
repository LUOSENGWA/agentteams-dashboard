// POST /api/auth/login - Dual-track multi-user authentication (M19 / batch M).
//
// Track Console (deployment admin account):
//   Console /session/login. The Console is single-operator: whoever holds the
//   admin password IS the deployment admin. Identity = the logged-in username
//   itself (NO Human CR lookup — the Console admin account is not required to
//   have a Human CR). The session carries the admin SA credential
//   (server-side only, level 3). The Higress Console session cookie is still
//   forwarded so the gateway tab (/api/higress/*) keeps working.
//
// Track Matrix (any Human account):
//   Server-side Matrix password login → own access token → localpart →
//   SA GET /humans/{localpart}; permissionLevel maps 1→3 (full),
//   2→2 (scoped to accessibleTeams), 3→1 (observer). Level 3 via this track
//   additionally requires admin verification (admin account password OR a
//   pasted Controller admin token) before the session may use admin-grade
//   data-plane credentials.
//   The session carries the user's Matrix token (server-side only) as the
//   Controller credential for level 2/3 — A2 chain scopes reads to
//   accessibleTeams. Non-Human Matrix accounts (no CR) → generic 401.
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
    // Optional admin verification (two alternatives) — only consumed by the
    // Matrix track for top-permission (CR level 1) accounts; see
    // attemptMatrixLogin. adminUsername+adminPassword (Console check) OR
    // controllerToken (Bearer check against the Controller).
    const adminUsername = typeof body.adminUsername === 'string' ? body.adminUsername.trim() : '';
    const adminPassword = typeof body.adminPassword === 'string' ? body.adminPassword : '';
    const controllerToken = typeof body.controllerToken === 'string' ? body.controllerToken.trim() : '';

    if (!username || !password) {
      return NextResponse.json({ success: false, error: 'Username and password are required' }, { status: 400 });
    }

    // Dual track: try the Console (L1) first; on failure fall through to
    // Matrix (any Human level).
    // External mode (upstream #76): no init, no Matrix token/URL to the
    // remote client.
    const l1 = await attemptConsoleLogin(request, username, password, { allowMatrix: !isExternal });
    if (l1.kind === 'session') {
      return l1.response;
    }
    if (l1.kind === 'misconfigured') {
      return l1.response;
    }

    return await attemptMatrixLogin(request, username, password, adminUsername, adminPassword, controllerToken);
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
 * Console track: admin login → level-3 session with the SA credential.
 * Forwards the Console session cookie so the gateway tab keeps working.
 */
async function attemptConsoleLogin(
  request: NextRequest,
  username: string,
  password: string,
  opts: { allowMatrix: boolean },
): Promise<ConsoleAttempt> {
  let consoleUrl: string;
  try {
    consoleUrl = getHigressConsoleURL();
  } catch (err) {
    // Console deployment config invalid (e.g. host not on the allowlist in a
    // one-person-per-instance LAN deployment): the Console track is
    // unavailable, but the Matrix track does not depend on it — fall through
    // so one track's misconfiguration never blocks the whole login endpoint.
    console.error(
      `Console track unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'failed' };
  }

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

  // Identity = the Console username itself. The Console admin account and the
  // Human CRs are different accounts (the Console admin may have no CR):
  // no CR lookup here.
  let cookieValue: string;
  try {
    ({ cookieValue } = createSession({
      user: username,
      crLevel: 1,
      teams: [],
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
        user: { username, level: 3 },
        mode: 'higress',
        matrix,
      }),
      { status: 200, headers: responseHeaders },
    ),
  };
}

/** Human CRD permissionLevel → dashboard level (E5 inversion). */
const MATRIX_CR_LEVEL_TO_DASH_LEVEL: Record<number, 1 | 2 | 3> = { 1: 3, 2: 2, 3: 1 };

/**
 * Verify the admin account's Console credentials (deployment admin username +
 * password). Returns true only when the Console accepts them. Used to gate
 * admin-level data-plane access for top-permission accounts logging in via
 * the Matrix track — replaces pasting the raw Controller token: the token
 * never leaves the server (it is the AGENTTEAMS_AUTH_TOKEN env value).
 */
async function verifyAdminConsoleCredentials(username: string, password: string): Promise<boolean> {
  try {
    const { response } = await callHigressConsole('/session/login', {
      method: 'POST',
      body: { username, password },
      consoleUrl: getHigressConsoleURL(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Verify a user-supplied Controller admin token by calling an admin endpoint.
 * Returns true only when the Controller accepts it.
 */
async function verifyControllerToken(request: NextRequest, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${getControllerUrl(request)}/api/v1/teams/`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Matrix track: password login for ANY Human account (top-permission level
 * 1 / operators level 2 / observers level 3) → session carrying server-side
 * credentials. The level is derived from the Human CR's permissionLevel —
 * never from the username string.
 *
 * Credential selection:
 * - Dashboard level 3 via Matrix (CR level 1): the Controller's Matrix auth
 *   only accepts level-2 tokens, so the user's own Matrix token would 401 on
 *   every data-plane call. Admin-level data access is gated on EITHER
 *   verifying the admin account's CONSOLE PASSWORD (adminUsername/
 *   adminPassword → session uses the server's SA token, kind 'sa', which
 *   never leaves the server) OR a pasted Controller admin TOKEN (verified
 *   against the Controller → kind 'controller-token', held server-side only;
 *   same as the workbench plugin's admin-token mode). The Matrix token is
 *   still returned for the chat tab.
 * - Dashboard level 2/3 (CR level 2/3): the user's own Matrix token; A2
 *   scopes level-2 reads to accessibleTeams. Admin verification is ignored.
 */
async function attemptMatrixLogin(
  request: NextRequest,
  username: string,
  password: string,
  adminUsername: string,
  adminPassword: string,
  controllerToken: string,
): Promise<NextResponse> {
  const matrix = await tryMatrixLogin(username, password);
  if (!matrix || !matrix.accessToken) {
    return NextResponse.json({ success: false, error: 'Invalid username or password' }, { status: 401 });
  }

  const userId = typeof matrix.userId === 'string' ? matrix.userId : '';
  const localpart = userId.startsWith('@') ? userId.slice(1).split(':')[0] : username;
  const human = await fetchHumanViaSa(request, localpart);
  const crLevel = human && typeof human.permissionLevel === 'number' ? human.permissionLevel : -1;
  const dashLevel = MATRIX_CR_LEVEL_TO_DASH_LEVEL[crLevel];
  if (!human || !dashLevel) {
    // No Human CR (or unknown level) for this Matrix account → generic 401.
    return NextResponse.json({ success: false, error: 'Invalid username or password' }, { status: 401 });
  }

  // Level 3 via Matrix (CR level 1): the data plane needs admin-grade access
  // (the Controller's Matrix auth rejects level-1 tokens). Gate it on EITHER
  // the admin account's Console password OR a pasted Controller admin token.
  let credential: { kind: 'sa' } | { kind: 'matrix'; token: string } | { kind: 'controller-token'; token: string };
  if (dashLevel === 3) {
    if (adminUsername && adminPassword) {
      const adminOk = await verifyAdminConsoleCredentials(adminUsername, adminPassword);
      if (!adminOk) {
        return NextResponse.json({ success: false, error: '管理员账号验证失败（账号或密码不正确）' }, { status: 401 });
      }
      credential = { kind: 'sa' };
    } else if (controllerToken) {
      const tokenOk = await verifyControllerToken(request, controllerToken);
      if (!tokenOk) {
        return NextResponse.json({ success: false, error: 'Controller 管理员 token 无效' }, { status: 401 });
      }
      credential = { kind: 'controller-token', token: controllerToken };
    } else {
      return NextResponse.json(
        {
          success: false,
          error: 'L1 账号需要管理员验证：请展开「管理员账号验证」填写管理员账号与密码，或 Controller 管理员 token（二选一，由部署管理员提供）',
        },
        { status: 400 },
      );
    }
  } else {
    credential = { kind: 'matrix', token: String(matrix.accessToken) };
  }

  let cookieValue: string;
  try {
    ({ cookieValue } = createSession({
      user: human.name || localpart,
      crLevel,
      // Level 3 (full admin) is not team-restricted; L2/L3 users are scoped.
      teams: dashLevel === 3 ? [] : (human.accessibleTeams ?? []),
      credential,
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
      user: { username: human.name || localpart, level: dashLevel },
      mode: 'matrix',
      matrix,
    }),
    { status: 200, headers: responseHeaders },
  );
}

