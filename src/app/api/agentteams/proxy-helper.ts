// Shared proxy helper for AgentTeams API routes
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/dashboard-session';
import { pickBackendUrl } from '@/lib/backend-config';

const TIMEOUT_MS = 10000;

// Allowed controller URL hosts to prevent SSRF (only applies to user-supplied ?controllerUrl=)
// In production/k3s mode the env var AGENTTEAMS_CONTROLLER_URL is authoritative.
const ALLOWED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'agentteams-controller',
  'agentteams-controller.agentteams-system',
  'agentteams-controller.agentteams-system.svc',
  'agentteams-controller.agentteams-system.svc.cluster.local',
];

async function readAuthTokenFromFile(path: string): Promise<string | undefined> {
  try {
    // Use dynamic import so this code can still run in non-Node environments (e.g. tests)
    const fs = await import('fs');
    return fs.readFileSync(path, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

export async function getAuthToken(): Promise<string | undefined> {
  // Do NOT cache: projected service-account tokens rotate (e.g. every 3600s).
  // Re-read on every call so we never send a stale token to the controller.
  return (
    process.env.AGENTTEAMS_AUTH_TOKEN ||
    (process.env.AGENTTEAMS_AUTH_TOKEN_FILE
      ? await readAuthTokenFromFile(process.env.AGENTTEAMS_AUTH_TOKEN_FILE)
      : undefined)
  );
}

function getDefaultControllerUrl(): string {
  // F1 resolution: first-launch config file (dual address + failover) >
  // env vars > embedded in-cluster default. pickBackendUrl also returns the
  // last-known-working address while its probe TTL is fresh, so a flaky
  // primary automatically falls back to the secondary.
  const configured = pickBackendUrl('controller');
  if (configured) return configured;
  // Default to the in-cluster service name so a missing env var does not
  // cause the dashboard to proxy to itself on localhost.
  return process.env.AGENTTEAMS_API_URL || 'http://agentteams-controller:8090';
}

export function getControllerUrl(request: NextRequest): string {
  const defaultUrl = getDefaultControllerUrl();
  const url = request.nextUrl.searchParams.get('controllerUrl');
  if (url) {
    // F1b: the per-request override is L1-only. An L2 (own-scope, Matrix
    // credential) session must always hit the deployment-configured
    // controller so the A2 self-scope chain and audit attribution stay
    // intact — a redirected request would land on a controller that has no
    // notion of this user's scope. Pre-login requests (login flow, public
    // setup endpoints) keep the override behind the SSRF allowlist as before.
    // Level 3 sessions are exactly the admin-credential sessions ('sa' /
    // 'controller-token' — see the login route's credential selection).
    const session = getSessionFromRequest(request);
    if (session && session.level < 3) {
      return defaultUrl;
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Invalid protocol');
      }
      if (
        !ALLOWED_HOSTS.includes(parsed.hostname) &&
        !parsed.hostname.endsWith('.svc') &&
        !parsed.hostname.endsWith('.svc.cluster.local') &&
        !parsed.hostname.endsWith('.cluster.local') &&
        !parsed.hostname.endsWith('.local')
      ) {
        throw new Error('Host not allowed');
      }
    } catch {
      // If validation fails, fall back to default
      return defaultUrl;
    }
    return url;
  }
  return defaultUrl;
}

export async function proxyToAgentTeams(
  request: NextRequest,
  controllerUrl: string,
  path: string,
  options: {
    method?: string;
    forwardBody?: boolean;
    contentType?: string;
    /** Stream the upstream body instead of buffering into memory
     * (large binary downloads, e.g. artifact files). */
    stream?: boolean;
    /** Extra response headers to pass through to the client (e.g.
     * 'content-disposition' for binary download routes). Only these are
     * forwarded; everything else is filtered. */
    passthroughHeaders?: string[];
  } = {}
): Promise<NextResponse> {
  const { method = request.method, forwardBody = true, contentType } = options;
  const targetUrl = new URL(path, controllerUrl).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const fetchOptions: RequestInit = {
      method,
      signal: controller.signal,
      headers: {},
    };

    // Per-session Controller credential (M19 dual-track):
    // - L2 session → the user's own Matrix access token, held in the
    //   server-side session store (A2 chain scopes the request to the user's
    //   teams; token never touches the browser).
    // - L1 session / AUTH_DISABLED → the admin SA token.
    // When a server-side credential exists, NEVER trust the browser-supplied
    // Authorization header (token-injection protection, upstream #89). The
    // browser header is only a fallback when no server-side credential exists
    // at all (legacy dev setups).
    const session = getSessionFromRequest(request);
    const sessionToken =
      session?.credential.kind === 'matrix' || session?.credential.kind === 'controller-token'
        ? session.credential.token
        : undefined;
    const saToken = await getAuthToken();
    const authToken = sessionToken || saToken || (
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || undefined
    );
    if (authToken) {
      (fetchOptions.headers as Record<string, string>)['authorization'] = `Bearer ${authToken}`;
    }

    // Forward the server-resolved identity (set by middleware from the
    // dashboard session) so the controller can attribute write actions to the
    // right user without trusting browser-supplied headers.
    for (const name of ['x-agentteams-user', 'x-agentteams-user-level']) {
      const value = request.headers.get(name);
      if (value) (fetchOptions.headers as Record<string, string>)[name] = value;
    }

    if (forwardBody && ['POST', 'PUT', 'PATCH'].includes(method)) {
      if (contentType === 'multipart/form-data') {
        // Forward multipart as-is (don't set Content-Type, let fetch handle boundary)
        const body = await request.arrayBuffer();
        fetchOptions.body = body;
        // Copy the content-type header from the original request
        const origCT = request.headers.get('content-type');
        if (origCT) {
          (fetchOptions.headers as Record<string, string>)['content-type'] = origCT;
        }
      } else {
        fetchOptions.body = await request.text();
        (fetchOptions.headers as Record<string, string>)['content-type'] = 'application/json';
      }
    }

    const res = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeout);

    // For 204 No Content
    if (res.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    if (options.stream && res.body) {
      // Stream the binary body through without buffering (D15).
      const responseHeaders = new Headers();
      const resCT = res.headers.get('content-type');
      if (resCT) responseHeaders.set('content-type', resCT);
      for (const name of options.passthroughHeaders ?? []) {
        const value = res.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      responseHeaders.set('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      return new NextResponse(res.body, {
        status: res.status,
        headers: responseHeaders,
      });
    }

    const data = await res.arrayBuffer();
    const responseHeaders = new Headers();
    const resCT = res.headers.get('content-type');
    if (resCT) responseHeaders.set('content-type', resCT);
    // Pass through any explicitly requested headers (e.g. content-disposition
    // for artifact downloads so RFC 5987 filenames survive the proxy).
    for (const name of options.passthroughHeaders ?? []) {
      const value = res.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    // API responses should never be cached by the browser; stale cached JSON
    // causes the dashboard to show outdated or empty data after restarts.
    responseHeaders.set('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    responseHeaders.set('pragma', 'no-cache');
    responseHeaders.set('expires', '0');

    return new NextResponse(data, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const message = err instanceof Error && err.name === 'AbortError'
      ? 'Request timeout'
      : err instanceof Error
        ? err.message
        : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
