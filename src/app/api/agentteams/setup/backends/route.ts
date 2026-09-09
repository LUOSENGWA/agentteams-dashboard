// /api/agentteams/setup/backends — dashboard-level backend address config (F1).
//
// GET (public, pre-login readable): reports whether the dashboard is usable
// (required backends have at least one candidate address). Drives the
// first-launch gate on the root page: unconfigured -> backend setup UI
// instead of the login form. The embedded auto-detect probe only runs in the
// unconfigured case so normal deployments pay zero extra latency.
//
// POST (two auth modes — plugin parity, F1c):
//   - post-login (L1 or L2, any level): any logged-in user may create or
//     overwrite the config. The deployment model is one instance per user
//     (own docker, remote AgentTeams), so the instance's users ARE the
//     plugin's "user of this host" — the plugin's config page is equally
//     open to whoever is logged into the host, with no extra credential.
//     The SSRF surface of user-supplied addresses stays pinned by
//     DASHBOARD_ALLOWED_HOSTS; config editing does not touch credentials
//     (L1 SA token / L2 session tokens stay server-side).
//   - pre-login one-shot: body.token must equal the setup token AND the
//     config file must not exist yet. This is the only way a logged-out
//     browser can write backend addresses (first launch on a standalone
//     docker install — the plugin has no equivalent because the host is
//     already authenticated; this is the dashboard's install-method
//     difference, approved 9/9). After the file exists, this mode is
//     permanently rejected — no config re-do from the login screen.
//
// Every successful save re-probes the saved backends (plugin put_config →
// refresh_effective) and returns `effective` / `switched` for the UI banner.
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSessionFromRequest } from '@/lib/dashboard-session';
import {
  BACKEND_NAMES,
  EMBEDDED_DEFAULTS,
  REQUIRED_BACKENDS,
  backendCandidates,
  configExists,
  effectiveUrl,
  getSetupToken,
  isHttpUrl,
  probeBackend,
  readConfigSync,
  refreshEffective,
  saveConfigOneShot,
  updateConfig,
  type BackendAddrs,
  type BackendName,
} from '@/lib/backend-config';

type BackendNameSet = Record<string, BackendName>;

function parseBackendsPayload(
  raw: unknown,
): { backends?: Partial<Record<BackendName, BackendAddrs>>; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'backends must be an object' };
  }
  const out: Partial<Record<BackendName, BackendAddrs>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in BACKEND_NAMES_SET)) {
      return { error: `unknown backend "${key}"` };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: `backend "${key}" must be an object` };
    }
    const entry = value as Record<string, unknown>;
    const addrs: BackendAddrs = {};
    for (const slot of ['internal', 'external'] as const) {
      const candidate = entry[slot];
      if (candidate === undefined || candidate === null || candidate === '') continue;
      if (typeof candidate !== 'string' || !isHttpUrl(candidate)) {
        return { error: `backend "${key}" ${slot} must be an http(s) URL` };
      }
      addrs[slot] = candidate.trim();
    }
    if (addrs.internal || addrs.external) out[key as BackendName] = addrs;
  }
  return { backends: out };
}

const BACKEND_NAMES_SET: BackendNameSet = Object.fromEntries(
  BACKEND_NAMES.map((name) => [name, name]),
);

export async function GET(request: NextRequest) {
  const config = readConfigSync();
  const perBackend: Record<string, { configured: boolean; candidates: string[] }> = {};
  let configured = true;
  for (const name of BACKEND_NAMES) {
    const candidates = backendCandidates(name, config);
    perBackend[name] = { configured: candidates.length > 0, candidates };
    if (REQUIRED_BACKENDS.includes(name) && candidates.length === 0) configured = false;
  }

  let healthy: Record<string, boolean> | null = null;
  if (!configured) {
    // First-launch auto-detect: probe the embedded topology defaults in
    // parallel so the setup page can offer a one-click "use defaults".
    const probed = await Promise.all(
      BACKEND_NAMES.filter((name) => EMBEDDED_DEFAULTS[name]).map(async (name) => {
        const result = await probeBackend(name, EMBEDDED_DEFAULTS[name] as string, 2000);
        return [name, result.httpOk] as const;
      }),
    );
    healthy = Object.fromEntries(probed);
  }

  // The structured file config (internal/external per backend) is exposed
  // to any AUTHENTICATED session — the settings backend tab is visible and
  // editable to L1 and L2 alike (plugin parity: whoever uses this instance
  // edits this instance's config). Pre-login callers (the first-launch
  // page) get candidates and embedded defaults only.
  const session = getSessionFromRequest(request);
  const authedConfig = session ? { config: config?.backends ?? {} } : {};

  // Effective (working-cache) address per backend — the "在生效" badge data.
  const effective: Partial<Record<BackendName, string>> = {};
  for (const name of BACKEND_NAMES) {
    const url = effectiveUrl(name);
    if (url) effective[name] = url;
  }

  return NextResponse.json({
    configured,
    backends: perBackend,
    embedded: { defaults: EMBEDDED_DEFAULTS, healthy },
    ...authedConfig,
    effective,
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    backends?: unknown;
  } | null;

  const parsed = parseBackendsPayload(body?.backends);
  if (parsed.error || !parsed.backends) {
    return NextResponse.json({ error: parsed.error ?? 'invalid payload' }, { status: 400 });
  }
  if (Object.keys(parsed.backends).length === 0) {
    return NextResponse.json({ error: 'at least one address is required' }, { status: 400 });
  }

  const session = getSessionFromRequest(request);
  const token = typeof body?.token === 'string' ? body.token : undefined;

  if (session) {
    // Post-login (L1 or L2, plugin parity): repeatable create/overwrite.
    const result = await updateConfig(parsed.backends);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    // Re-probe what was just saved (plugin put_config → refresh_effective):
    // the effective address is latency-elected from real probes, not seeded
    // blindly.
    const { effective, switched } = await refreshEffective(Object.keys(parsed.backends) as BackendName[]);
    return NextResponse.json({ ok: true, mode: 'update', effective, switched });
  }

  // Pre-login one-shot: token-gated, only while no config exists.
  if (!token) {
    return NextResponse.json({ error: 'token-required' }, { status: 403 });
  }
  if (!(await verifySetupToken(token))) {
    return NextResponse.json({ error: 'invalid-token' }, { status: 403 });
  }
  if (await configExists()) {
    return NextResponse.json({ error: 'already-configured' }, { status: 403 });
  }
  const result = await saveConfigOneShot(parsed.backends);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  // Re-probe the fresh config so the effective cache is honest from the
  // first request (replaces the old blind first-address seed).
  const { effective, switched } = await refreshEffective(Object.keys(parsed.backends) as BackendName[]);
  return NextResponse.json({ ok: true, mode: 'first-launch', effective, switched });
}

async function verifySetupToken(token: string): Promise<boolean> {
  const expected = await getSetupToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
