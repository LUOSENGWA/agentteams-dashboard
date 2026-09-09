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
  configExists,
  configFilePath,
  forgetWorking,
  getSetupToken,
  isHttpUrl,
  isTestTargetAllowed,
  markWorking,
  pickBackendUrl,
  probeBackend,
  readConfigSync,
  saveConfigOneShot,
  updateConfig,
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
      vi.advanceTimersByTime(70_000);
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

  it('treats a higress 404 as "gateway up, route missing"', async () => {
    const result = await probeBackend('higress-gateway', base);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain('route');
    expect(paths[paths.length - 1]).toBe('POST /v1/chat/completions');
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
