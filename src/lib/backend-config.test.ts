// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  BACKEND_NAMES,
  EMBEDDED_DEFAULTS,
  backendCandidates,
  backendCandidatesSync,
  classifyProbeError,
  configExists,
  configFilePath,
  effectiveUrl,
  forgetWorking,
  getSetupToken,
  isHttpUrl,
  isTestTargetAllowed,
  listMatchesSaved,
  markWorking,
  orderedCandidates,
  pickBackendUrl,
  probeBackend,
  readConfigSync,
  refreshEffective,
  saveConfigOneShot,
  selectAndMark,
  toProbeRow,
  updateConfig,
  type ProbeRow,
} from './backend-config';

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-config-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('DASHBOARD_CONFIG_FILE', path.join(workDir, 'config.json'));
  vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', '');
  vi.stubEnv('DASHBOARD_SETUP_TOKEN', '');
  for (const name of BACKEND_NAMES) forgetWorking(name);
});

afterEach(() => {
  const file = path.join(workDir, 'config.json');
  if (fs.existsSync(file)) fs.rmSync(file);
  const token = path.join(workDir, '.setup-token');
  if (fs.existsSync(token)) fs.rmSync(token);
  vi.unstubAllEnvs();
});

describe('isHttpUrl', () => {
  it('accepts http/https only', () => {
    expect(isHttpUrl('http://a:8090')).toBe(true);
    expect(isHttpUrl('https://a.example.com')).toBe(true);
    expect(isHttpUrl('ftp://a')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });
});

describe('readConfigSync / normalization', () => {
  it('returns null when the file is missing or corrupt', () => {
    expect(readConfigSync()).toBeNull();
    fs.writeFileSync(configFilePath(), '{not json');
    expect(readConfigSync()).toBeNull();
  });

  it('drops malformed entries but keeps valid ones', () => {
    fs.writeFileSync(
      configFilePath(),
      JSON.stringify({
        version: 1,
        backends: {
          controller: { internal: 'http://ctl:8090', external: 'ftp://bad' },
          matrix: { internal: 42 },
          sglang: { external: 'http://s:8000' },
        },
      }),
    );
    const config = readConfigSync();
    expect(config?.backends.controller).toEqual({ internal: 'http://ctl:8090' });
    expect(config?.backends.matrix).toBeUndefined();
    expect(config?.backends.sglang).toEqual({ external: 'http://s:8000' });
  });
});

describe('backendCandidates (order: config internal > config external > env)', () => {
  it('orders and dedupes', () => {
    vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', 'http://env:8090');
    const config = readConfigSync();
    const from = backendCandidates('controller', {
      version: 1,
      backends: { controller: { internal: 'http://in:8090', external: 'http://out:8090' } },
    });
    expect(from).toEqual(['http://in:8090', 'http://out:8090', 'http://env:8090']);
    // duplicate between file and env collapses
    const dup = backendCandidates('controller', {
      version: 1,
      backends: { controller: { internal: 'http://env:8090' } },
    });
    expect(dup).toEqual(['http://env:8090']);
    expect(config).toBeNull();
  });

  it('backendCandidatesSync reads the file', () => {
    fs.writeFileSync(
      configFilePath(),
      JSON.stringify({ version: 1, backends: { sglang: { internal: 'http://file:8000' } } }),
    );
    vi.stubEnv('AGENTTEAMS_SGLANG_URL', 'http://env:8000');
    expect(backendCandidatesSync('sglang')).toEqual(['http://file:8000', 'http://env:8000']);
  });
});

describe('saveConfigOneShot / updateConfig', () => {
  it('one-shot: first write succeeds, second is rejected', async () => {
    expect(await saveConfigOneShot({ controller: { internal: 'http://a:8090' } })).toEqual({ ok: true });
    expect(await configExists()).toBe(true);
    expect(await saveConfigOneShot({ matrix: { internal: 'http://b:6167' } })).toEqual({
      ok: false,
      error: 'already-configured',
    });
    // file unchanged
    expect(readConfigSync()?.backends.matrix).toBeUndefined();
  });

  it('one-shot rejects an all-invalid payload', async () => {
    const result = await saveConfigOneShot({ controller: { external: 'ftp://nope' } });
    expect(result.ok).toBe(false);
    expect(await configExists()).toBe(false);
  });

  it('updateConfig creates and overwrites', async () => {
    expect(await updateConfig({ controller: { internal: 'http://a:8090' } })).toEqual({ ok: true });
    expect(await updateConfig({ matrix: { internal: 'http://b:6167' } })).toEqual({ ok: true });
    const config = readConfigSync();
    expect(config?.backends.controller).toBeUndefined(); // overwritten
    expect(config?.backends.matrix).toEqual({ internal: 'http://b:6167' });
  });
});

describe('getSetupToken', () => {
  it('env token wins', async () => {
    vi.stubEnv('DASHBOARD_SETUP_TOKEN', 'env-token');
    expect(await getSetupToken()).toBe('env-token');
  });

  it('auto-generates, persists, and is stable across calls', async () => {
    const first = await getSetupToken();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(await getSetupToken()).toBe(first);
    expect(fs.existsSync(path.join(workDir, '.setup-token'))).toBe(true);
  });
});

describe('pickBackendUrl + working cache', () => {
  it('falls back through the candidate list', () => {
    expect(pickBackendUrl('sglang')).toBeUndefined();
    vi.stubEnv('AGENTTEAMS_SGLANG_URL', 'http://env:8000');
    expect(pickBackendUrl('sglang')).toBe('http://env:8000');
  });

  it('recently probed working address wins over the candidate order', () => {
    fs.writeFileSync(
      configFilePath(),
      JSON.stringify({
        version: 1,
        backends: { sglang: { internal: 'http://in:8000', external: 'http://out:8000' } },
      }),
    );
    markWorking('sglang', 'http://out:8000');
    expect(pickBackendUrl('sglang')).toBe('http://out:8000');
    // a working address that is no longer a candidate is ignored
    markWorking('sglang', 'http://ghost:8000');
    expect(pickBackendUrl('sglang')).toBe('http://in:8000');
  });

  it('working entry wins while fresh, expires after the TTL', () => {
    vi.useFakeTimers();
    try {
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({ version: 1, backends: { sglang: { internal: 'http://in:8000' } } }),
      );
      vi.stubEnv('AGENTTEAMS_SGLANG_URL', 'http://env:8000');
      // candidates = [in:8000 (file), env:8000]; mark the second as working.
      markWorking('sglang', 'http://env:8000');
      expect(pickBackendUrl('sglang')).toBe('http://env:8000');
      vi.advanceTimersByTime(700_000);
      // expired → fall back to the first candidate.
      expect(pickBackendUrl('sglang')).toBe('http://in:8000');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isTestTargetAllowed', () => {
  it('empty filter allows everything; configured filter is exclusive (exact or subdomain)', () => {
    vi.stubEnv('DASHBOARD_ALLOWED_HOSTS', '');
    expect(isTestTargetAllowed('http://anything.example.com:1234/x')).toBe(true);
    vi.stubEnv('DASHBOARD_ALLOWED_HOSTS', 'a.example.com');
    expect(isTestTargetAllowed('http://a.example.com/')).toBe(true);
    expect(isTestTargetAllowed('http://sub.a.example.com/')).toBe(true);
    expect(isTestTargetAllowed('http://evil-a.example.com/')).toBe(false);
    expect(isTestTargetAllowed('not-a-url')).toBe(false);
  });
});

describe('probeBackend', () => {
  let server: Server;
  let base: string;
  const paths: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`);
      if (req.url === '/ok' || req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } else if (req.url === '/missing' || req.url === '/v1/chat/completions') {
        res.writeHead(404);
        res.end('nf');
      } else {
        res.writeHead(500);
        res.end('boom');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no server address');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('maps health paths per backend kind and records latency', async () => {
    const result = await probeBackend('controller', base);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(paths[paths.length - 1]).toBe('GET /healthz');
  });

  it('treats a higress 404 as "gateway up, route missing" (connected, not httpOk)', async () => {
    const result = await probeBackend('higress-gateway', base);
    expect(result.ok).toBe(true); // the gateway answered → network connected
    expect(result.httpOk).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain('路由');
    expect(paths[paths.length - 1]).toBe('POST /v1/chat/completions');
  });

  it('401 is connected but not usable (two-layer model)', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Basic' });
      res.end('nope');
    });
    const result = await probeBackend('matrix', base);
    expect(result.ok).toBe(true);
    expect(result.httpOk).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBeUndefined();
    expect(toProbeRow(base, result).detail).toContain('需鉴权');
  });

  it('reports unreachable targets with an error', async () => {
    const result = await probeBackend('sglang', 'http://127.0.0.1:1');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('embedded defaults are the documented embedded topology (no sglang)', () => {
    expect(EMBEDDED_DEFAULTS.controller).toBe('http://agentteams-controller:8090');
    expect(EMBEDDED_DEFAULTS.sglang).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F1c: plugin parity — election, error classification, candidate order,
// applied-only cache updates, refresh_effective
// ---------------------------------------------------------------------------

const row = (url: string, ms: number | null, ok = true, httpOk = true): ProbeRow => ({
  url,
  ok,
  httpOk,
  ms,
  detail: '',
});

describe('selectAndMark (port of plugin _select_and_mark)', () => {
  it('no current working → elects the fastest reachable', () => {
    const picked = selectAndMark('controller', [row('http://slow:8090', 208), row('http://fast:8090', 100)]);
    expect(picked).toBe('http://fast:8090');
    expect(effectiveUrl('controller')).toBe('http://fast:8090');
  });

  it('challenger 108ms faster (> max(100ms, 30%)) → switches', () => {
    markWorking('controller', 'http://slow:8090', 208);
    const picked = selectAndMark('controller', [row('http://slow:8090', 208), row('http://fast:8090', 100)]);
    expect(picked).toBe('http://fast:8090');
  });

  it('challenger 50ms faster (< 100ms floor) → hysteresis holds the current', () => {
    markWorking('controller', 'http://slow:8090', 208);
    const picked = selectAndMark('controller', [row('http://slow:8090', 208), row('http://fast:8090', 158)]);
    expect(picked).toBe('http://slow:8090');
    expect(effectiveUrl('controller')).toBe('http://slow:8090');
  });

  it('current unreachable → switches to the fastest immediately', () => {
    markWorking('controller', 'http://dead:8090', 120);
    const picked = selectAndMark('controller', [
      row('http://dead:8090', null, false, false),
      row('http://ok:8090', 300),
      row('http://ok2:8090', 180),
    ]);
    expect(picked).toBe('http://ok2:8090');
  });

  it('nobody reachable → working cache untouched', () => {
    markWorking('controller', 'http://keep:8090', 90);
    const picked = selectAndMark('controller', [
      row('http://a:8090', null, false, false),
      row('http://b:8090', null, false, false),
    ]);
    expect(picked).toBeNull();
    expect(effectiveUrl('controller')).toBe('http://keep:8090');
  });

  it('a connected-but-401 address is never elected', () => {
    const picked = selectAndMark('controller', [
      row('http://auth:8090', 10, true, false),
      row('http://plain:8090', 200),
    ]);
    expect(picked).toBe('http://plain:8090');
  });
});

describe('classifyProbeError (port of plugin _classify_error)', () => {
  const withCode = (code: string, message?: string) => {
    const err = new Error(message ?? `failed (${code})`);
    (err as { code?: string }).code = code;
    return err;
  };
  const wrapped = (cause: unknown) => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = cause;
    return err;
  };

  it('timeout (AbortError) → 连接超时', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyProbeError(err, true)).toContain('连接超时');
  });

  it('DNS failure (ENOTFOUND, undici-wrapped)', () => {
    expect(
      classifyProbeError(wrapped(withCode('ENOTFOUND', 'getaddrinfo ENOTFOUND badhost')), false),
    ).toContain('DNS 解析失败');
  });

  it('ECONNREFUSED → 连接被拒绝', () => {
    expect(classifyProbeError(wrapped(withCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1')), false)).toContain(
      '连接被拒绝',
    );
  });

  it('certificate verification failure stays a certificate error', () => {
    expect(classifyProbeError(wrapped(new Error('unable to verify the first certificate')), false)).toContain('证书');
  });

  it('handshake interruption is a handshake error (NOT a certificate error)', () => {
    const out = classifyProbeError(wrapped(new Error('TLS handshake failed: wrong version number')), false);
    expect(out).toContain('握手');
    expect(out).not.toContain('证书校验失败');
  });

  it('unknown error → 连接失败 with the message preserved', () => {
    const out = classifyProbeError(wrapped(withCode('EACCES', 'permission denied')), false);
    expect(out).toContain('连接失败');
    expect(out).toContain('permission denied');
  });
});

describe('orderedCandidates (request-layer failover order)', () => {
  it('fresh working address first, then config internal → external → env, deduped', () => {
    fs.writeFileSync(
      configFilePath(),
      JSON.stringify({ version: 1, backends: { controller: { internal: 'http://in:8090', external: 'http://out:8090' } } }),
    );
    vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', 'http://env:8090');
    markWorking('controller', 'http://out:8090');
    expect(orderedCandidates('controller')).toEqual(['http://out:8090', 'http://in:8090', 'http://env:8090']);
  });

  it('no working entry → plain candidate order', () => {
    vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', 'http://env:8090');
    expect(orderedCandidates('controller')).toEqual(['http://env:8090']);
  });

  it('a working address that is no longer a candidate is excluded (ghost guard, same as pickBackendUrl)', () => {
    markWorking('controller', 'http://ghost:8090');
    vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', 'http://env:8090');
    expect(orderedCandidates('controller')).toEqual(['http://env:8090']);
  });
});

describe('listMatchesSaved (plugin config_test "applied" semantics)', () => {
  it('tested list equal to the saved config list (any slot order) → applies', () => {
    fs.writeFileSync(
      configFilePath(),
      JSON.stringify({ version: 1, backends: { controller: { internal: 'http://in:8090', external: 'http://out:8090' } } }),
    );
    expect(listMatchesSaved('controller', ['http://out:8090', 'http://in:8090'])).toBe(true);
  });

  it('draft differs from the saved list → does not apply', () => {
    fs.writeFileSync(
      configFilePath(),
      JSON.stringify({ version: 1, backends: { controller: { internal: 'http://in:8090' } } }),
    );
    expect(listMatchesSaved('controller', ['http://other:8090'])).toBe(false);
    expect(listMatchesSaved('controller', ['http://in:8090', 'http://extra:8090'])).toBe(false);
  });

  it('no saved config (env-only deployment) → never applies', () => {
    expect(listMatchesSaved('controller', ['http://env:8090'])).toBe(false);
  });
});

describe('refreshEffective (port of plugin refresh_effective)', () => {
  let fast: Server;
  let slow: Server;
  let fastUrl: string;
  let slowUrl: string;

  beforeAll(async () => {
    fast = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    slow = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, 150);
    });
    await new Promise<void>((resolve) => fast.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const fa = fast.address();
    const sa = slow.address();
    if (!fa || typeof fa === 'string' || !sa || typeof sa === 'string') throw new Error('no server');
    fastUrl = `http://127.0.0.1:${fa.port}`;
    slowUrl = `http://127.0.0.1:${sa.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fast.close(() => resolve()));
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  });

  it('elects the fastest reachable candidate; re-runs switch across the hysteresis gap', async () => {
    fs.writeFileSync(
      configFilePath(),
      JSON.stringify({ version: 1, backends: { sglang: { internal: fastUrl, external: slowUrl } } }),
    );
    const first = await refreshEffective(['sglang']);
    expect(first.effective.sglang).toBe(fastUrl);
    expect(first.switched.sglang).toBeUndefined(); // no previous working address

    // Simulate a previous effective = the slow address; the ~150ms gap clears
    // max(100ms, 30%) → the re-probe switches back to the fast one.
    markWorking('sglang', slowUrl, 150);
    const second = await refreshEffective(['sglang']);
    expect(second.effective.sglang).toBe(fastUrl);
    expect(second.switched.sglang).toBe(true);
  });

  it('a failed round never clears the existing effective address', async () => {
    markWorking('sglang', fastUrl, 10);
    fs.writeFileSync(
      configFilePath(),
      JSON.stringify({
        version: 1,
        backends: { sglang: { internal: 'http://127.0.0.1:1', external: 'http://127.0.0.1:2' } },
      }),
    );
    const result = await refreshEffective(['sglang'], 1500);
    expect(result.effective.sglang).toBeUndefined();
    expect(effectiveUrl('sglang')).toBe(fastUrl);
  });
});
