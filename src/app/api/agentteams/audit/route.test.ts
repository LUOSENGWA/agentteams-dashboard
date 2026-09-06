// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { setAuditLogPathForTests } from '@/lib/audit-log';

let server: Server;
let controllerUrl: string;
let tmpDir: string;
let logPath: string;
const received: Array<{ method: string; url: string; body?: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  controllerUrl = `http://127.0.0.1:${address.port}`;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-route-'));
  logPath = path.join(tmpDir, 'audit.log.jsonl');
  setAuditLogPathForTests(logPath);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  received.length = 0;
});

function makeRequest(pathSuffix: string, init: { method?: string; body?: string; admin?: boolean; actor?: string; level?: number } = {}) {
  const url = new URL(`http://localhost${pathSuffix}`);
  url.searchParams.set('controllerUrl', controllerUrl);
  const headers: Record<string, string> = {};
  if (init.body) headers['content-type'] = 'application/json';
  if (init.admin !== false) {
    headers['x-agentteams-user'] = init.actor ?? 'admin';
    headers['x-agentteams-user-level'] = String(init.level ?? 3);
  }
  return new NextRequest(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
  });
}

describe('GET /api/agentteams/audit', () => {
  it('returns 403 when the caller has no identity (dev / auth disabled)', async () => {
    const res = await GET(makeRequest('/api/agentteams/audit', { admin: false }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: '需要审计权限', requiredLevel: 2 });
    expect(body.observedLevel).toBeNull();
  });

  it('returns 403 with observedLevel=1 for a level-1 caller', async () => {
    const url = new URL('http://localhost/api/agentteams/audit');
    const req = new NextRequest(url, {
      method: 'GET',
      headers: {
        'x-agentteams-user': 'junior',
        'x-agentteams-user-level': '1',
      },
    });
    const res = await GET(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.observedLevel).toBe(1);
    expect(body.requiredLevel).toBe(2);
  });

  it('returns 200 with the full log when admin (L3)', async () => {
    const res = await GET(makeRequest('/api/agentteams/audit', { actor: 'admin', level: 3 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.scope).toBe('all');
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('returns 200 scoped to the auditor for an L2 caller', async () => {
    // Seed two events: one by admin, one by auditor-l2; auditor should only see their own.
    await POST(
      makeRequest('/api/agentteams/audit', {
        method: 'POST',
        body: JSON.stringify({
          entity_type: 'worker',
          entity_name: 'w-by-admin',
          action: 'create',
        }),
        actor: 'admin',
        level: 3,
      }),
    );
    await POST(
      makeRequest('/api/agentteams/audit', {
        method: 'POST',
        body: JSON.stringify({
          entity_type: 'worker',
          entity_name: 'w-by-l2',
          action: 'create',
        }),
        actor: 'auditor-l2',
        level: 2,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const res = await GET(
      makeRequest('/api/agentteams/audit', { actor: 'auditor-l2', level: 2 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.scope).toBe('self');
    expect(Array.isArray(body.events)).toBe(true);
    for (const ev of body.events) {
      expect(ev.actor).toBe('auditor-l2');
    }
    expect(body.events.some((ev: { entity_name: string }) => ev.entity_name === 'w-by-admin')).toBe(false);
  });
});

describe('POST /api/agentteams/audit', () => {
  it('returns 403 when no identity header is present', async () => {
    const res = await POST(makeRequest('/api/agentteams/audit', { method: 'POST', body: '{}', admin: false }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when the payload is missing required fields', async () => {
    const res = await POST(makeRequest('/api/agentteams/audit', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(400);
  });

  it('writes a valid event to the JSONL log', async () => {
    const res = await POST(
      makeRequest('/api/agentteams/audit', {
        method: 'POST',
        body: JSON.stringify({
          entity_type: 'worker',
          entity_name: 'w-from-test',
          action: 'create',
          severity: 'info',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.id).toMatch(/^audit-/);

    // Wait briefly for fs.appendFile to flush, then verify the line landed.
    await new Promise((r) => setTimeout(r, 20));
    const content = await fs.readFile(logPath, 'utf8');
    expect(content).toContain('w-from-test');
    expect(content).toContain('"action":"create"');
  });
});