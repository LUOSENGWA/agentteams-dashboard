// Dashboard session store — multi-user login (M19 / batch M).
//
// Design (合一文档 §11.1 v1.4):
// - The browser receives a signed, HttpOnly session cookie. It contains only a
//   session id + display name — NEVER a Controller/Matrix token.
// - Per-user credentials live in a server-side in-memory map (see
//   proxy-helper: "NEVER trust browser-supplied Authorization header").
// - Controller credential selection:
//     L1 (dashboard level 3) → the admin SA token from env (full access)
//     L2 (dashboard level 2) → the user's own Matrix access token (A2 chain:
//       whoami → Human CR → team-scoped reads + same-team project writes)
// - Level mapping (E5, 级别量表反转): the Human CRD scale is INVERTED relative
//   to this dashboard's rbac-engine scale.
//     CRD 1 (L1 admin)  → dashboard 3 (Admin)
//     CRD 2 (L2 team)   → dashboard 2 (Operator)
//     CRD 3 (L3 worker) → dashboard 1 (Observer)
// - Container restart ⇒ in-memory store lost ⇒ everyone re-logs in. Documented.
// - The session secret MUST be provided via DASHBOARD_SESSION_SECRET (hex,
//   ≥32 bytes). Missing/short secret = fail closed (login refused, loud log).
//
// Reference implementation: git d9182c4^:src/lib/auth-local.ts (deleted 7/3).

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const SESSION_COOKIE_NAME = 'at_dash_sess';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SESSIONS = 1000;

/** Controller credential carried server-side per session. */
export type ControllerCredential =
  | { kind: 'sa' } // Admin data-plane access: the admin SA token from env
  //   (never leaves the server). Used by the Console track AND by
  //   top-permission (CR level 1) accounts logging in via the Matrix track
  //   after their admin account password has been verified — the Controller's
  //   Matrix auth only accepts level-2 tokens, so a level-1 Matrix token
  //   cannot be the data-plane credential.
  | { kind: 'matrix'; token: string }; // Own-permission accounts (CR level 2/3):
  //   the user's own Matrix access token; A2 scopes reads to accessibleTeams.

export interface DashboardSession {
  sid: string;
  /** Human CR name / display username (luo / sunzong / maizong). */
  user: string;
  /** Dashboard rbac-engine level: 1 Observer / 2 Operator / 3 Admin. */
  level: 1 | 2 | 3;
  /** Human CR permissionLevel (1=L1 / 2=L2 / 3=L3) — kept for audit/debug. */
  crLevel: number;
  /** Human CR accessibleTeams (L2 scoping; informational — Controller enforces). */
  teams: string[];
  credential: ControllerCredential;
  createdAt: number;
}

interface SessionStore {
  sessions: Map<string, DashboardSession>;
  insertionOrder: string[];
}

// Store instance lives on globalThis, NOT at module level. Next.js bundles
// the middleware chunk and the app-router chunk separately, so each would get
// its own module instance — and with a module-level Map the middleware could
// never see sessions created by the login route (every data request would
// 401 with a perfectly valid cookie). All bundles run in the same standalone
// node process, so globalThis is the one state they all share.
// (Constraint: single process — container restart / multi-replica = everyone
// re-logs in, which is the documented behavior.)
const globalForSessions = globalThis as typeof globalThis & { __agentteamsSessions?: SessionStore };
const store: SessionStore =
  globalForSessions.__agentteamsSessions ??= { sessions: new Map(), insertionOrder: [] };

function getSecret(): string | null {
  const secret = process.env.DASHBOARD_SESSION_SECRET || '';
  if (secret.length < 64) {
    return null; // hex of ≥32 bytes
  }
  return secret;
}

let secretWarned = false;
function requireSecret(): string {
  const secret = getSecret();
  if (!secret) {
    if (!secretWarned) {
      secretWarned = true;
      console.error(
        '[dashboard-session] DASHBOARD_SESSION_SECRET is missing or too short (<64 hex chars). ' +
          'Multi-user login is DISABLED (fail closed). Set it in the dashboard container env.',
      );
    }
    throw new Error('DASHBOARD_SESSION_SECRET not configured');
  }
  return secret;
}

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded).digest('base64url');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Map Human CRD permissionLevel → dashboard rbac-engine level (E5 inversion). */
export function mapCrLevelToDashLevel(crLevel: number): 1 | 2 | 3 {
  if (crLevel === 1) return 3;
  if (crLevel === 2) return 2;
  return 1;
}

export interface CreateSessionInput {
  user: string;
  crLevel: number;
  teams?: string[];
  credential: ControllerCredential;
}

/** Create a session and return the signed cookie value. */
export function createSession(input: CreateSessionInput): { sessionId: string; cookieValue: string } {
  const secret = requireSecret();
  const sid = randomBytes(32).toString('hex');
  const session: DashboardSession = {
    sid,
    user: input.user,
    level: mapCrLevelToDashLevel(input.crLevel),
    crLevel: input.crLevel,
    teams: input.teams ?? [],
    credential: input.credential,
    createdAt: Date.now(),
  };
  store.sessions.set(sid, session);
  store.insertionOrder.push(sid);
  if (store.insertionOrder.length > MAX_SESSIONS) {
    const evicted = store.insertionOrder.shift();
    if (evicted) store.sessions.delete(evicted);
  }
  const payload = JSON.stringify({ sid, user: session.user, iat: Date.now(), exp: Date.now() + SESSION_MAX_AGE_MS });
  const encoded = Buffer.from(payload).toString('base64url');
  return { sessionId: sid, cookieValue: `${encoded}.${sign(encoded, secret)}` };
}

/** Validate a signed cookie value and return the live session (if still present server-side). */
export function validateSessionToken(token: string): DashboardSession | null {
  const secret = getSecret();
  if (!secret) return null;
  try {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const encoded = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!timingSafeEqualStr(sign(encoded, secret), signature)) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as {
      sid?: string;
      exp?: number;
    };
    if (!payload.sid || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return store.sessions.get(payload.sid) ?? null;
  } catch {
    return null;
  }
}

export function destroySession(sessionId: string): void {
  store.sessions.delete(sessionId);
  store.insertionOrder = store.insertionOrder.filter((s) => s !== sessionId);
}

/** Parse the `Cookie` header of a request into a record. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Resolve the dashboard session from a request Cookie header. */
export function getSessionFromRequest(request: { headers: { get(_name: string): string | null } }): DashboardSession | null {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  return validateSessionToken(token);
}

/** Build the Set-Cookie header value for a session. */
export function sessionCookieHeader(cookieValue: string): string {
  const secure = process.env.DASHBOARD_COOKIE_SECURE === '1' ? '; Secure' : '';
  return (
    `${SESSION_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}${secure}`
  );
}

/** Set-Cookie value that clears the session cookie. */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Test/ops helper — drop all in-memory sessions. */
export function __resetSessionStoreForTests(): void {
  store.sessions.clear();
  store.insertionOrder.length = 0;
}
