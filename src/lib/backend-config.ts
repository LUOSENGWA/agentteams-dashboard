// Dashboard backend configuration (F1: first-launch backend setup).
//
// Every backend the dashboard talks to (controller, matrix, minio,
// higress gateway/console, sglang) supports two addresses — internal /
// external — mirroring the workbench plugin's dual-address model. The
// dashboard server resolves which address to use at request time:
//
//   resolution:  config file > env vars
//   failover:    last-known-working address (probed, TTL-cached) wins,
//                then config internal, config external, env — in that order.
//
// Persistence: a small JSON file (DASHBOARD_CONFIG_FILE) on a mounted
// volume. It is written ONCE at first launch by the pre-login setup page
// (token-gated, one-shot) and may be updated afterwards only by a level-3
// (L1 admin) session. Read access is a plain synchronous file read per
// request (tiny file, local disk) — same pattern as the per-call token
// re-read in proxy-helper, which deliberately avoids stale caches.

// Node builtins are loaded LAZILY (dynamic import) so this module can be
// imported from non-Node environments (jsdom unit tests) without crashing —
// same convention as proxy-helper's token-file read. In Node the fs module
// is warmed at module init; the sync read path (readConfigSync) uses the
// warmed cache and degrades to "no config file" until it is available,
// which is the correct behavior in test environments.
import {
  BACKEND_NAMES,
  EMBEDDED_DEFAULTS,
  REQUIRED_BACKENDS,
  type BackendName,
} from './backend-names';

export { BACKEND_NAMES, EMBEDDED_DEFAULTS, REQUIRED_BACKENDS, type BackendName };

type FsModule = typeof import('fs');

let fsPromise: Promise<FsModule> | null = null;
let fsResolved: FsModule | null = null;

function loadFs(): Promise<FsModule> {
  if (!fsPromise) {
    fsPromise = import('fs')
      .then((mod) => {
        fsResolved = mod;
        return mod;
      })
      .catch((err) => {
        fsPromise = null; // non-Node environment: stay degraded, don't poison retries
        throw err;
      });
  }
  return fsPromise;
}

// Warm the fs cache at module init (Node server + node-env tests).
loadFs().catch(() => {
  /* jsdom etc.: readConfigSync returns null, async writers throw at call time */
});

export interface BackendAddrs {
  internal?: string;
  external?: string;
}

export interface DashboardConfig {
  version: number;
  backends: Partial<Record<BackendName, BackendAddrs>>;
}

export function configFilePath(): string {
  return (process.env.DASHBOARD_CONFIG_FILE || '/data/agentteams-dashboard/config.json').trim();
}

async function tokenFilePath(): Promise<string> {
  const path = await import('path');
  return path.join(path.dirname(configFilePath()), '.setup-token');
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export function isHttpUrl(value: string | undefined | null): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Optional SSRF filter for the pre-login "test connection" endpoint.
// Empty (default) = allow any http(s) target — this is a local
// self-configuration tool; operators can pin exact hosts if they want.
export function isTestTargetAllowed(url: string): boolean {
  const fromEnv = (process.env.DASHBOARD_ALLOWED_HOSTS || '').trim();
  if (!fromEnv) return true;
  let hostname: string;
  try {
    hostname = new URL(url.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  const allowed = fromEnv
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return allowed.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

// ---------------------------------------------------------------------------
// Config file access (sync read — see header; async writes)
// ---------------------------------------------------------------------------

function normalizeConfig(parsed: unknown): DashboardConfig | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Partial<DashboardConfig>;
  if (!candidate.backends || typeof candidate.backends !== 'object') return null;
  // Keep only valid entries; silently drop malformed ones so a partially
  // edited file cannot take the dashboard down.
  const backends: DashboardConfig['backends'] = {};
  for (const name of BACKEND_NAMES) {
    const entry = candidate.backends[name];
    if (!entry || typeof entry !== 'object') continue;
    const out: BackendAddrs = {};
    if (isHttpUrl(entry.internal)) out.internal = entry.internal.trim();
    if (isHttpUrl(entry.external)) out.external = entry.external.trim();
    if (out.internal || out.external) backends[name] = out;
  }
  return { version: 1, backends };
}

export function readConfigSync(): DashboardConfig | null {
  // Sync contract (called from sync URL resolution in proxy-helper). Uses the
  // module-init-warmed fs cache; null until warm or in non-Node environments.
  if (!fsResolved) return null;
  try {
    const raw = fsResolved.readFileSync(configFilePath(), 'utf-8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function configExists(): Promise<boolean> {
  const fsp = (await loadFs()).promises;
  try {
    await fsp.access(configFilePath());
    return true;
  } catch {
    return false;
  }
}

async function writeConfigAtomic(config: DashboardConfig): Promise<void> {
  const fsp = (await loadFs()).promises;
  const path = await import('path');
  const file = configFilePath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o644 });
  await fsp.rename(tmp, file);
}

/** Pre-login one-shot write: only succeeds while no config file exists.
 * Unlike updateConfig it rejects a payload with no valid address at all —
 * a first-launch save that ends up configuring nothing is a user error, not
 * a meaningful state. */
export async function saveConfigOneShot(
  backends: DashboardConfig['backends'],
): Promise<{ ok: boolean; error?: string }> {
  if (await configExists()) return { ok: false, error: 'already-configured' };
  const config = normalizeConfig({ version: 1, backends });
  if (!config) return { ok: false, error: 'invalid-config' };
  if (Object.keys(config.backends).length === 0) return { ok: false, error: 'invalid-config' };
  await writeConfigAtomic(config);
  return { ok: true };
}

/** Level-3 (L1 admin) update: creates or overwrites the config file. */
export async function updateConfig(
  backends: DashboardConfig['backends'],
): Promise<{ ok: boolean; error?: string }> {
  const config = normalizeConfig({ version: 1, backends });
  if (!config) return { ok: false, error: 'invalid-config' };
  await writeConfigAtomic(config);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Address resolution (config file > env) + failover working cache
// ---------------------------------------------------------------------------

function envAddr(name: BackendName): string | undefined {
  const env = process.env;
  switch (name) {
    case 'controller':
      return env.AGENTTEAMS_CONTROLLER_URL || env.AGENTTEAMS_API_URL;
    case 'matrix':
      return env.AGENTTEAMS_MATRIX_URL || env.NEXT_PUBLIC_MATRIX_API_URL;
    case 'minio':
      return env.AGENTTEAMS_FS_ENDPOINT || env.AGENTTEAMS_MINIO_ENDPOINT || env.AGENTTEAMS_MINIO_URL;
    case 'higress-gateway':
      return env.AGENTTEAMS_AI_GATEWAY_URL;
    case 'higress-console':
      return env.AGENTTEAMS_AI_GATEWAY_ADMIN_URL;
    case 'sglang':
      return env.AGENTTEAMS_SGLANG_URL;
  }
}

/** Candidate order for one backend: config internal, config external, env.
 * Deduped; invalid URLs dropped. */
export function backendCandidates(name: BackendName, config: DashboardConfig | null): string[] {
  const out: string[] = [];
  const add = (value: string | undefined) => {
    if (value && isHttpUrl(value) && !out.includes(value.trim())) out.push(value.trim());
  };
  add(config?.backends[name]?.internal);
  add(config?.backends[name]?.external);
  add(envAddr(name));
  return out;
}

export function backendCandidatesSync(name: BackendName): string[] {
  return backendCandidates(name, readConfigSync());
}

const WORKING_TTL_MS = 60_000;
interface WorkingEntry {
  url: string;
  at: number;
}

// globalThis-scoped on purpose (same lesson as the session store, 87cb478):
// Next may instantiate a server module more than once per process; a plain
// module-level Map would then fragment the working cache.
function workingMap(): Map<BackendName, WorkingEntry> {
  const g = globalThis as unknown as { __dashboardBackendWorking?: Map<BackendName, WorkingEntry> };
  if (!g.__dashboardBackendWorking) g.__dashboardBackendWorking = new Map();
  return g.__dashboardBackendWorking;
}

export function markWorking(name: BackendName, url: string): void {
  workingMap().set(name, { url: url.trim(), at: Date.now() });
}

export function forgetWorking(name: BackendName): void {
  workingMap().delete(name);
}

/** Best address for a backend right now: the recently-probed working one if
 * it is still a candidate, else the first candidate. */
export function pickBackendUrl(name: BackendName): string | undefined {
  const candidates = backendCandidatesSync(name);
  const entry = workingMap().get(name);
  if (entry && Date.now() - entry.at < WORKING_TTL_MS && candidates.includes(entry.url)) {
    return entry.url;
  }
  return candidates[0];
}

// ---------------------------------------------------------------------------
// First-launch setup token (gates the pre-auth one-shot write)
// ---------------------------------------------------------------------------

export async function getSetupToken(): Promise<string> {
  const fromEnv = (process.env.DASHBOARD_SETUP_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const fsp = (await loadFs()).promises;
  const path = await import('path');
  const tokenFile = await tokenFilePath();
  try {
    const persisted = (await fsp.readFile(tokenFile, 'utf-8')).trim();
    if (persisted) return persisted;
  } catch {
    // fall through to generation
  }
  const crypto = await import('crypto');
  const token = crypto.randomBytes(16).toString('hex');
  try {
    await fsp.mkdir(path.dirname(tokenFile), { recursive: true });
    await fsp.writeFile(tokenFile, token, { mode: 0o600 });
  } catch {
    // Read-only fs (tests): the token is still usable in this process.
  }
  // The pre-login setup page tells the user where to find it. console.error
  // (not log): the no-console lint rule only permits warn/error, and the
  // token must land in the plain `docker logs` stream either way.
  console.error(`[dashboard] one-time backend setup token: ${token}`);
  return token;
}

// ---------------------------------------------------------------------------
// Health probes (per-kind path; also used by the infrastructure panel)
// ---------------------------------------------------------------------------

const PROBE_PATHS: Record<BackendName, { path: string; method?: 'POST'; body?: string }> = {
  controller: { path: '/healthz' },
  matrix: { path: '/_matrix/client/versions' },
  minio: { path: '/minio/health/live' },
  // POST /v1/chat/completions with an unauthenticated probe: 404 = route
  // missing (unreachable), any other status = gateway is up.
  'higress-gateway': {
    path: '/v1/chat/completions',
    method: 'POST',
    body: JSON.stringify({ model: 'probe', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
  },
  // Console (Next.js): any HTTP response means it is up.
  'higress-console': { path: '/' },
  sglang: { path: '/v1/models' },
};

export interface ProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

export async function probeBackend(
  name: BackendName,
  url: string,
  timeoutMs = 5000,
): Promise<ProbeResult> {
  const spec = PROBE_PATHS[name];
  const target = new URL(spec.path, url.replace(/\/+$/, '')).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(target, {
      method: spec.method ?? 'GET',
      signal: controller.signal,
      headers: spec.body ? { 'content-type': 'application/json' } : undefined,
      body: spec.body,
    });
    const latencyMs = Date.now() - startedAt;
    if (name === 'higress-gateway') {
      // 404 means the AI route is missing, not that the gateway is down.
      if (res.status === 404) {
        return { ok: false, status: 404, latencyMs, error: 'AI route not found (gateway up, route missing)' };
      }
      return { ok: true, status: res.status, latencyMs };
    }
    if (name === 'higress-console') {
      return { ok: true, status: res.status, latencyMs };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, latencyMs };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error && err.name === 'AbortError' ? 'timeout' : err instanceof Error ? err.message : 'Unknown error',
    };
  } finally {
    clearTimeout(timeout);
  }
}
