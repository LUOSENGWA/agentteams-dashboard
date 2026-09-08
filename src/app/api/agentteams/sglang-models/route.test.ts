// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { NextRequest } from 'next/server';
import { GET } from './route';

let server: Server;
let sglangUrl: string;
const receivedPaths: string[] = [];
let response: { status: number; body: string } = {
  status: 200,
  body: JSON.stringify({
    data: [
      { id: 'qwen3.6-27b-fp8', object: 'model' },
      { id: 'qwen3.6-27b-fp8', object: 'model' },
      'raw-string-model',
      { object: 'model' },
      { id: '', object: 'model' },
    ],
  }),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    receivedPaths.push(req.url ?? '');
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(response.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  sglangUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  receivedPaths.length = 0;
  response = { status: 200, body: '{}' };
  vi.unstubAllEnvs();
});

function makeRequest() {
  return new NextRequest('http://localhost/api/agentteams/sglang-models');
}

describe('GET /api/agentteams/sglang-models', () => {
  it('returns disabled and empty when AGENTTEAMS_SGLANG_URL is unset', async () => {
    delete process.env.AGENTTEAMS_SGLANG_URL;

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, models: [] });
    expect(receivedPaths).toHaveLength(0);
  });

  it('lists served models on /v1/models, deduped and tolerant to mixed entry shapes', async () => {
    response = {
      status: 200,
      body: JSON.stringify({
        data: [
          { id: 'qwen3.6-27b-fp8', object: 'model' },
          { id: 'qwen3.6-27b-fp8', object: 'model' },
          'raw-string-model',
          { object: 'model' },
          { id: '', object: 'model' },
        ],
      }),
    };
    vi.stubEnv('AGENTTEAMS_SGLANG_URL', sglangUrl);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(receivedPaths).toEqual(['/v1/models']);
    expect(await res.json()).toEqual({
      enabled: true,
      models: ['qwen3.6-27b-fp8', 'raw-string-model'],
    });
  });

  it('accepts a base URL that already ends in /v1 (no /v1/v1 doubling)', async () => {
    response.body = JSON.stringify({ data: [{ id: 'a-model' }] });
    vi.stubEnv('AGENTTEAMS_SGLANG_URL', `${sglangUrl}/v1/`);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(receivedPaths).toEqual(['/v1/models']);
    expect(await res.json()).toEqual({ enabled: true, models: ['a-model'] });
  });

  it('maps a non-2xx SGLang answer to 502 with an empty list', async () => {
    response = { status: 500, body: '{"error":"boom"}' };
    vi.stubEnv('AGENTTEAMS_SGLANG_URL', sglangUrl);

    const res = await GET(makeRequest());

    expect(res.status).toBe(502);
    const body = (await res.json()) as { enabled: boolean; models: string[]; error: string };
    expect(body.enabled).toBe(true);
    expect(body.models).toEqual([]);
    expect(body.error).toContain('500');
  });

  it('tolerates a malformed SGLang body with an empty list', async () => {
    response = { status: 200, body: 'this is not json' };
    vi.stubEnv('AGENTTEAMS_SGLANG_URL', sglangUrl);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, models: [] });
  });

  it('maps an unreachable SGLang to 503 with an empty list', async () => {
    vi.stubEnv('AGENTTEAMS_SGLANG_URL', 'http://127.0.0.1:1');

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    const body = (await res.json()) as { enabled: boolean; models: string[]; error: string };
    expect(body.enabled).toBe(true);
    expect(body.models).toEqual([]);
    expect(body.error).toBeTruthy();
  });
});
