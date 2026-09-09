// /api/agentteams/setup/backends — dashboard-level backend address config (F1).
//
// GET (public, pre-login readable): reports whether the dashboard is usable
// (required backends have at least one candidate address). Drives the
// first-launch gate on the root page: unconfigured -> backend setup UI
// instead of the login form. The embedded auto-detect probe only runs in the
// unconfigured case so normal deployments pay zero extra latency.
//
// POST (two auth modes):
//   - pre-login one-shot: body.token must equal the setup token AND the
//     config file must not exist yet. This is the only way a logged-out
//     browser can write backend addresses (first launch on a standalone
//     docker install). After the file exists, this mode is permanently
//     rejected — no config re-do from the login screen.
//   - post-login L1: session at dashboard level 3 (admin) may create or
//     overwrite the config at any time.
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSessionFromRequest } from '@/lib/dashboard-session';
import {
  BACKEND_NAMES,
  EMBEDDED_DEFAULTS,
  REQUIRED_BACKENDS,
  backendCandidates,
  configExists,
  getSetupToken,
  isHttpUrl,
  markWorking,
  probeBackend,
  readConfigSync,
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

export async function GET() {
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
        return [name, result.ok] as const;
      }),
    );
    healthy = Object.fromEntries(probed);
  }

  return NextResponse.json({
    configured,
    backends: perBackend,
    embedded: { defaults: EMBEDDED_DEFAULTS, healthy },
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
  if (session && session.level >= 3) {
    // L1 admin (post-login): repeatable create/overwrite.
    const result = await updateConfig(parsed.backends);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, mode: 'l1-update' });
  }

  // Pre-login one-shot: token-gated, only while no config exists.
  const token = typeof body?.token === 'string' ? body.token : undefined;
  if (!token) {
    return NextResponse.json({ error: 'token-required' }, { status: 403 });
  }
  const expected = await getSetupToken();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
    return NextResponse.json({ error: 'invalid-token' }, { status: 403 });
  }
  if (await configExists()) {
    return NextResponse.json({ error: 'already-configured' }, { status: 403 });
  }
  const result = await saveConfigOneShot(parsed.backends);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  // The user just proved these addresses — seed the failover working cache.
  for (const [name, addrs] of Object.entries(parsed.backends)) {
    const first = addrs?.internal || addrs?.external;
    if (first) markWorking(name as BackendName, first);
  }
  return NextResponse.json({ ok: true, mode: 'first-launch' });
}
