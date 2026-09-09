// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import {
  __resetSessionStoreForTests,
  createSession,
  sessionCookieHeader,
} from '@/lib/dashboard-session';
import { BACKEND_NAMES, forgetWorking, readConfigSync } from '@/lib/backend-config';
import { GET, POST } from './route';

let workDir: string;

function configFile() {
  return path.join(workDir, 'config.json');
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-backends-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('DASHBOARD_CONFIG_FILE', configFile());
  vi.stubEnv('DASHBOARD_SETUP_TOKEN', 'test-token-123');
  // ≥64 hex chars (32+ bytes) — the session store fails closed below that.
  vi.stubEnv('DASHBOARD_SESSION_SECRET', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  // No env-configured backends by default (standalone first-launch scenario).
  vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', '');
  vi.stubEnv('AGENTTEAMS_API_URL', '');
  vi.stubEnv('AGENTTEAMS_MATRIX_URL', '');
  vi.stubEnv('NEXT_PUBLIC_MATRIX_API_URL', '');
  __resetSessionStoreForTests();
  for (const name of BACKEND_NAMES) forgetWorking(name);
});

afterEach(() => {
  for (const file of [configFile(), path.join(workDir, '.setup-token')]) {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  vi.unstubAllEnvs();
});

function makeRequest(init?: { method?: string; body?: string }, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest('http://localhost/api/agentteams/setup/backends', {
    method: init?.method,
    headers,
    body: init?.body,
  });
}

function l1Cookie(): string {
  const { cookieValue } = createSession({
    user: 'admin',
    crLevel: 1, // CRD 1 -> dashboard level 3 (L1 admin)
    credential: { kind: 'controller-token', token: 'dummy-sa-token' },
  });
  return sessionCookieHeader(cookieValue);
}

describe('GET /api/agentteams/setup/backends', () => {
  it('reports unconfigured standalone state with embedded auto-detect results', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      configured: boolean;
      backends: Record<string, { configured: boolean; candidates: string[] }>;
      embedded: { healthy: Record<string, boolean> | null };
    };
    expect(data.configured).toBe(false);
    expect(data.backends.controller.configured).toBe(false);
    expect(data.backends.sglang.configured).toBe(false);
    // unconfigured -> embedded defaults were probed (all unreachable in tests)
    expect(data.embedded.healthy?.controller).toBe(false);
  });

  it('reports configured when env provides the required backends', async () => {
    vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', 'http://ctl:8090');
    vi.stubEnv('AGENTTEAMS_MATRIX_URL', 'http://mx:6167');
    const res = await GET();
    const data = (await res.json()) as {
      configured: boolean;
      backends: Record<string, { candidates: string[] }>;
      embedded: { healthy: Record<string, boolean> | null };
    };
    expect(data.configured).toBe(true);
    expect(data.backends.controller.candidates).toEqual(['http://ctl:8090']);
    // configured -> no embedded probe (zero latency cost)
    expect(data.embedded.healthy).toBeNull();
  });

  it('file config overrides and extends env candidates', async () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ version: 1, backends: { controller: { internal: 'http://in:8090' } } }),
    );
    vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', 'http://env:8090');
    vi.stubEnv('AGENTTEAMS_MATRIX_URL', 'http://mx:6167');
    const res = await GET();
    const data = (await res.json()) as {
      backends: Record<string, { candidates: string[] }>;
    };
    expect(data.backends.controller.candidates).toEqual(['http://in:8090', 'http://env:8090']);
    expect(readConfigSync()?.backends.controller).toEqual({ internal: 'http://in:8090' });
  });
});

describe('POST /api/agentteams/setup/backends', () => {
  it('rejects a pre-login write without a token (403 token-required)', async () => {
    const res = await POST(
      makeRequest({ method: 'POST', body: JSON.stringify({ backends: { controller: { internal: 'http://a:8090' } } }) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'token-required' });
  });

  it('rejects a wrong token (403 invalid-token) and leaves no file', async () => {
    const res = await POST(
      makeRequest({ method: 'POST', body: JSON.stringify({ token: 'nope', backends: { controller: { internal: 'http://a:8090' } } }) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid-token' });
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('accepts the right token once, then is permanently one-shot (403 already-configured)', async () => {
    const payload = JSON.stringify({
      token: 'test-token-123',
      backends: { controller: { internal: 'http://a:8090' }, matrix: { external: 'http://mx:6167' } },
    });
    const first = await POST(makeRequest({ method: 'POST', body: payload }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, mode: 'first-launch' });
    expect(fs.existsSync(configFile())).toBe(true);

    const second = await POST(makeRequest({ method: 'POST', body: payload }));
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({ error: 'already-configured' });
  });

  it('rejects malformed payloads with 400', async () => {
    const cases = [
      JSON.stringify({ token: 'test-token-123', backends: { nope: { internal: 'http://a' } } }),
      JSON.stringify({ token: 'test-token-123', backends: { controller: { internal: 'ftp://a' } } }),
      JSON.stringify({ token: 'test-token-123', backends: {} }),
    ];
    for (const body of cases) {
      const res = await POST(makeRequest({ method: 'POST', body }));
      expect(res.status).toBe(400);
    }
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('L1 session (level 3) can update the config repeatedly, no token needed', async () => {
    const cookie = l1Cookie();
    const first = await POST(
      makeRequest({ method: 'POST', body: JSON.stringify({ backends: { controller: { internal: 'http://a:8090' } } }) }, cookie),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, mode: 'l1-update' });

    const second = await POST(
      makeRequest({ method: 'POST', body: JSON.stringify({ backends: { matrix: { internal: 'http://b:6167' } } }) }, cookie),
    );
    expect(second.status).toBe(200);
    // overwrite semantics: the second write replaces the first
    expect(readConfigSync()?.backends.controller).toBeUndefined();
    expect(readConfigSync()?.backends.matrix).toEqual({ internal: 'http://b:6167' });
  });

  it('L2 session (level 2) is rejected like an anonymous request', async () => {
    const { cookieValue } = createSession({
      user: 'worker-user',
      crLevel: 2, // CRD 2 -> dashboard level 2
      credential: { kind: 'matrix', token: 'dummy-matrix-token' },
    });
    const res = await POST(
      makeRequest(
        { method: 'POST', body: JSON.stringify({ backends: { controller: { internal: 'http://a:8090' } } }) },
        sessionCookieHeader(cookieValue),
      ),
    );
    expect(res.status).toBe(403);
  });
});
