// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { BACKEND_NAMES, effectiveUrl, forgetWorking } from '@/lib/backend-config';
import { POST } from './route';

let workDir: string;
let server: Server;
let goodUrl: string;

const configFile = () => path.join(workDir, 'config.json');

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backends-test-'));
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no server');
  goodUrl = `http://127.0.0.1:${a.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('DASHBOARD_CONFIG_FILE', configFile());
  vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', '');
  vi.stubEnv('AGENTTEAMS_SGLANG_URL', '');
  for (const name of BACKEND_NAMES) forgetWorking(name);
});

afterEach(() => {
  if (fs.existsSync(configFile())) fs.rmSync(configFile());
  vi.unstubAllEnvs();
});

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agentteams/setup/backends/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface TestResponse {
  ok: boolean;
  results: Record<string, Array<{ url: string; ok: boolean; httpOk: boolean; ms: number | null; detail: string }>>;
  effective: Record<string, string>;
  applied: boolean;
  switched: Record<string, boolean>;
}

describe('POST /api/agentteams/setup/backends/test (F1c plugin config_test semantics)', () => {
  it('a draft test returns rows but NEVER touches the effective cache (applied=false)', async () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ version: 1, backends: { controller: { internal: 'http://127.0.0.1:1' } } }),
    );
    const res = await POST(post({ backends: { controller: { internal: goodUrl } } }));
    const data = (await res.json()) as TestResponse;
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.results.controller[0].httpOk).toBe(true);
    expect(data.applied).toBe(false);
    expect(data.effective.controller).toBeUndefined();
    expect(effectiveUrl('controller')).toBeNull();
  });

  it('testing the saved list applies the election (draft == saved)', async () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        version: 1,
        backends: { controller: { internal: 'http://127.0.0.1:1', external: goodUrl } },
      }),
    );
    const res = await POST(
      post({ backends: { controller: { internal: 'http://127.0.0.1:1', external: goodUrl } } }),
    );
    const data = (await res.json()) as TestResponse;
    expect(data.applied).toBe(true);
    expect(data.effective.controller).toBe(goodUrl);
    expect(effectiveUrl('controller')).toBe(goodUrl);
  });

  it('a failed test never clears the existing effective address', async () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ version: 1, backends: { controller: { internal: goodUrl } } }),
    );
    // first: test the saved list → effective cache is elected from a real probe
    await POST(post({ backends: { controller: { internal: goodUrl } } }));
    expect(effectiveUrl('controller')).toBe(goodUrl);

    // now test a draft pointing at a dead address — applied=false, cache untouched
    const res = await POST(post({ backends: { controller: { internal: 'http://127.0.0.1:1' } } }));
    const data = (await res.json()) as TestResponse;
    expect(data.results.controller[0].ok).toBe(false);
    expect(effectiveUrl('controller')).toBe(goodUrl);
  });

  it('no body → tests the currently configured candidates', async () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ version: 1, backends: { sglang: { internal: goodUrl } } }),
    );
    const res = await POST(post({}));
    const data = (await res.json()) as TestResponse;
    expect(res.status).toBe(200);
    expect(data.results.sglang).toHaveLength(1);
    expect(data.results.sglang[0].url).toBe(goodUrl);
  });

  it('rejects disallowed hosts (SSRF filter) with 403', async () => {
    vi.stubEnv('DASHBOARD_ALLOWED_HOSTS', 'allowed.example.com');
    const res = await POST(post({ backends: { controller: { internal: 'http://evil.example.com:8090' } } }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('host-not-allowed');
  });

  it('rejects an invalid body with 400', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/agentteams/setup/backends/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"backends":"nope"}',
      }),
    );
    expect(res.status).toBe(400);
  });
});
