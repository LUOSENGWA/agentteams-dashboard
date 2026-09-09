// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from './proxy-helper';
import {
  SESSION_COOKIE_NAME,
  __resetSessionStoreForTests,
  createSession,
  destroySession,
  sessionCookieHeader,
} from '@/lib/dashboard-session';
import { effectiveUrl, forgetWorking, pickBackendUrl } from '@/lib/backend-config';

let server: Server;
let controllerUrl: string;
const received: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push({ method: req.method ?? '', url: req.url ?? '' });
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  controllerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('proxyToAgentTeams DELETE', () => {
  it('forwards the DELETE verb and path to the controller', async () => {
    received.length = 0;
    const request = new NextRequest('http://localhost/api/agentteams/teams/alpha-team', {
      method: 'DELETE',
    });

    const res = await proxyToAgentTeams(
      request,
      controllerUrl,
      '/api/v1/teams/alpha-team',
      { forwardBody: false, method: 'DELETE' }
    );

    expect(res.status).toBe(204);
    expect(received).toEqual([{ method: 'DELETE', url: '/api/v1/teams/alpha-team' }]);
  });

  it('surfaces a controller failure as a non-2xx proxy response (not swallowed)', async () => {
    // Swap the handler to reject the delete, then restore it.
    const originalHandler = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      received.push({ method: req.method ?? '', url: req.url ?? '' });
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end('{"error":"conflict"}');
    });

    const request = new NextRequest('http://localhost/api/agentteams/teams/alpha-team', {
      method: 'DELETE',
    });
    const res = await proxyToAgentTeams(
      request,
      controllerUrl,
      '/api/v1/teams/alpha-team',
      { forwardBody: false, method: 'DELETE' }
    );
    const body = await res.text();

    expect(res.status).toBe(409);
    expect(body).toContain('conflict');
    expect(received).toContainEqual({ method: 'DELETE', url: '/api/v1/teams/alpha-team' });

    server.removeAllListeners('request');
    server.on('request', originalHandler);
  });
});

describe('proxyToAgentTeams passthroughHeaders', () => {
  async function respondWithHeaders() {
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': "attachment; filename*=UTF-8''%E6%96%B9%E6%A1%88.pdf",
      });
      res.end('PDF-BYTES');
    });
    const request = new NextRequest('http://localhost/api/agentteams/projects/p1/tasks/t1/artifact', {
      method: 'GET',
    });
    const res = await proxyToAgentTeams(
      request,
      controllerUrl,
      '/api/v1/projects/p1/tasks/t1/artifact',
      { forwardBody: false },
    );
    return res;
  }

  it('does not forward content-disposition by default (existing behavior)', async () => {
    const res = await respondWithHeaders();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('forwards content-disposition when requested via passthroughHeaders', async () => {
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': "attachment; filename*=UTF-8''%E6%96%B9%E6%A1%88.pdf",
      });
      res.end('PDF-BYTES');
    });
    const request = new NextRequest('http://localhost/api/agentteams/projects/p1/tasks/t1/artifact', {
      method: 'GET',
    });
    const res = await proxyToAgentTeams(
      request,
      controllerUrl,
      '/api/v1/projects/p1/tasks/t1/artifact',
      { forwardBody: false, passthroughHeaders: ['content-disposition'] },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''%E6%96%B9%E6%A1%88.pdf",
    );
  });
});

describe('proxyToAgentTeams per-session credential (M19 dual track)', () => {
  let authServer: Server;
  let authUrl: string;
  const captured: Array<{ authorization: string | null; user: string | null; level: string | null }> = [];

  beforeAll(async () => {
    authServer = createServer((req, res) => {
      captured.push({
        authorization: (req.headers['authorization'] as string) ?? null,
        user: (req.headers['x-agentteams-user'] as string) ?? null,
        level: (req.headers['x-agentteams-user-level'] as string) ?? null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));
    const address = authServer.address();
    if (!address || typeof address === 'string') throw new Error('no server address');
    authUrl = `http://127.0.0.1:${address.port}`;
    process.env.DASHBOARD_SESSION_SECRET = 'e'.repeat(64);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
    delete process.env.DASHBOARD_SESSION_SECRET;
  });

  afterEach(() => {
    captured.length = 0;
    __resetSessionStoreForTests();
    delete process.env.AGENTTEAMS_AUTH_TOKEN;
    delete process.env.AGENTTEAMS_AUTH_TOKEN_FILE;
  });

  function requestWith(cookie: string | null, extra?: Record<string, string>) {
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
    return new NextRequest('http://localhost/api/agentteams/teams', { headers });
  }

  async function proxy(request: NextRequest) {
    return proxyToAgentTeams(request, authUrl, '/api/v1/teams', { forwardBody: false, method: 'GET' });
  }

  it('L2 session → forwards the session Matrix token; browser Authorization is ignored', async () => {
    process.env.AGENTTEAMS_AUTH_TOKEN = 'sa-admin-token';
    const { cookieValue } = createSession({
      user: 'sunzong',
      crLevel: 2,
      credential: { kind: 'matrix', token: 'syt_l2_token' },
    });
    await proxy(requestWith(`${SESSION_COOKIE_NAME}=${cookieValue}`, { authorization: 'Bearer browser-forged' }));
    expect(captured[0].authorization).toBe('Bearer syt_l2_token');
  });

  it('L1 session (SA credential) → forwards the SA env token; browser Authorization is ignored', async () => {
    process.env.AGENTTEAMS_AUTH_TOKEN = 'sa-admin-token';
    const { cookieValue } = createSession({ user: 'luo', crLevel: 1, credential: { kind: 'sa' } });
    await proxy(requestWith(`${SESSION_COOKIE_NAME}=${cookieValue}`, { authorization: 'Bearer browser-forged' }));
    expect(captured[0].authorization).toBe('Bearer sa-admin-token');
  });

  it('no session (AUTH_DISABLED path) → falls back to the SA env token', async () => {
    process.env.AGENTTEAMS_AUTH_TOKEN = 'sa-admin-token';
    await proxy(requestWith(null));
    expect(captured[0].authorization).toBe('Bearer sa-admin-token');
  });

  it('no server-side credential at all → legacy browser header fallback', async () => {
    await proxy(requestWith(null, { authorization: 'Bearer legacy-header-token' }));
    expect(captured[0].authorization).toBe('Bearer legacy-header-token');
  });

  it('forwards the server-resolved x-agentteams identity headers', async () => {
    const { cookieValue } = createSession({ user: 'sunzong', crLevel: 2, credential: { kind: 'matrix', token: 't' } });
    await proxy(requestWith(`${SESSION_COOKIE_NAME}=${cookieValue}`, {
      'x-agentteams-user': 'sunzong',
      'x-agentteams-user-level': '2',
    }));
    expect(captured[0].user).toBe('sunzong');
    expect(captured[0].level).toBe('2');
  });

  it('a forged cookie for a destroyed session sends no session token (SA fallback only)', async () => {
    process.env.AGENTTEAMS_AUTH_TOKEN = 'sa-admin-token';
    const { sessionId, cookieValue } = createSession({
      user: 'sunzong',
      crLevel: 2,
      credential: { kind: 'matrix', token: 'syt_l2_token' },
    });
    destroySession(sessionId);
    await proxy(requestWith(`${SESSION_COOKIE_NAME}=${cookieValue}`, { authorization: 'Bearer browser-forged' }));
    expect(captured[0].authorization).toBe('Bearer sa-admin-token');
  });
});

describe('getControllerUrl ?controllerUrl= override gating (F1b)', () => {
  const OVERRIDE = 'http://127.0.0.1:9999'; // allowed by the SSRF host list
  const DEFAULT_URL = 'http://ctl-default:8090';
  const saved = {
    secret: process.env.DASHBOARD_SESSION_SECRET,
    controller: process.env.AGENTTEAMS_CONTROLLER_URL,
    api: process.env.AGENTTEAMS_API_URL,
    configFile: process.env.DASHBOARD_CONFIG_FILE,
  };

  beforeAll(() => {
    process.env.DASHBOARD_SESSION_SECRET = 'f'.repeat(64);
    process.env.AGENTTEAMS_CONTROLLER_URL = DEFAULT_URL;
    process.env.AGENTTEAMS_API_URL = '';
    process.env.DASHBOARD_CONFIG_FILE = '/nonexistent-dir-for-tests/config.json';
    forgetWorking('controller');
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetSessionStoreForTests();
  });

  function withCookie(cookie: string | null, query: string): NextRequest {
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    return new NextRequest(`http://localhost/api/agentteams/healthz/${query}`, { headers });
  }

  function cookieFor(
    user: string,
    crLevel: number,
    credential: { kind: 'sa' } | { kind: 'matrix'; token: string } | { kind: 'controller-token'; token: string },
  ): string {
    const { cookieValue } = createSession({ user, crLevel, credential });
    return sessionCookieHeader(cookieValue);
  }

  it('L1 (level 3, sa credential): allowed-host override is honored', () => {
    const cookie = cookieFor('luo', 1, { kind: 'sa' });
    expect(getControllerUrl(withCookie(cookie, `?controllerUrl=${encodeURIComponent(OVERRIDE)}`))).toBe(OVERRIDE);
  });

  it('L2 (level 2, matrix credential): override is dropped, default used', () => {
    const cookie = cookieFor('sunzong', 2, { kind: 'matrix', token: 'syt_l2_token' });
    expect(getControllerUrl(withCookie(cookie, `?controllerUrl=${encodeURIComponent(OVERRIDE)}`))).toBe(DEFAULT_URL);
  });

  it('observer (level 1, matrix credential): override is dropped, default used', () => {
    const cookie = cookieFor('viewer', 3, { kind: 'matrix', token: 'viewer_token' });
    expect(getControllerUrl(withCookie(cookie, `?controllerUrl=${encodeURIComponent(OVERRIDE)}`))).toBe(DEFAULT_URL);
  });

  it('pre-login (no session): override still honored behind the SSRF list', () => {
    expect(getControllerUrl(withCookie(null, `?controllerUrl=${encodeURIComponent(OVERRIDE)}`))).toBe(OVERRIDE);
  });

  it('L1 session: non-allowed host is still rejected by the SSRF list', () => {
    const cookie = cookieFor('luo', 1, { kind: 'sa' });
    expect(getControllerUrl(withCookie(cookie, '?controllerUrl=http%3A%2F%2Fevil.example.com'))).toBe(DEFAULT_URL);
  });

  it('L2 session: no override parameter → default (unchanged behavior)', () => {
    const cookie = cookieFor('sunzong', 2, { kind: 'matrix', token: 'syt_l2_token' });
    expect(getControllerUrl(withCookie(cookie, ''))).toBe(DEFAULT_URL);
  });
});

describe('proxyToAgentTeams failover (F1c — plugin catch-all parity)', () => {
  let good: Server;
  let auth: Server;
  let goodUrl: string;
  let authUrl: string;
  let dead1: string;
  let dead2: string;
  let goodCalls = 0;
  let authCalls = 0;
  let configFile: string;

  function closedLoopbackPort(): Promise<number> {
    // Bind then close → the port is free (and refused) for the test.
    const tmp = createServer();
    const listen = new Promise<void>((resolve) => tmp.listen(0, '127.0.0.1', resolve));
    return Promise.resolve(listen).then(async () => {
      const a = tmp.address();
      if (!a || typeof a === 'string') throw new Error('no tmp server');
      await new Promise<void>((resolve) => tmp.close(() => resolve()));
      return a.port;
    });
  }

  beforeAll(async () => {
    good = createServer((_req, res) => {
      goodCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    auth = createServer((_req, res) => {
      authCalls += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
    });
    await Promise.all([
      new Promise<void>((resolve) => good.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => auth.listen(0, '127.0.0.1', resolve)),
    ]);
    const ga = good.address();
    const aa = auth.address();
    if (!ga || typeof ga === 'string' || !aa || typeof aa === 'string') throw new Error('no server');
    goodUrl = `http://127.0.0.1:${ga.port}`;
    authUrl = `http://127.0.0.1:${aa.port}`;
    const [p1, p2] = await Promise.all([closedLoopbackPort(), closedLoopbackPort()]);
    dead1 = `http://127.0.0.1:${p1}`;
    dead2 = `http://127.0.0.1:${p2}`;
    configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-failover-')), 'config.json');
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => good.close(() => resolve())),
      new Promise<void>((resolve) => auth.close(() => resolve())),
    ]);
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
  });

  beforeEach(() => {
    goodCalls = 0;
    authCalls = 0;
    forgetWorking('controller');
    vi.stubEnv('DASHBOARD_CONFIG_FILE', configFile);
    vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', '');
    vi.stubEnv('AGENTTEAMS_API_URL', '');
    vi.stubEnv('DASHBOARD_SESSION_SECRET', 'c'.repeat(64));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    forgetWorking('controller');
    if (fs.existsSync(configFile)) fs.rmSync(configFile);
  });

  function writeConfig(internal: string, external: string) {
    fs.writeFileSync(
      configFile,
      JSON.stringify({ version: 1, backends: { controller: { internal, external } } }),
    );
  }

  function req(query = ''): NextRequest {
    return new NextRequest(`http://localhost/api/agentteams/teams${query}`, { method: 'GET' });
  }

  it('dead first candidate → same-address retry → walks to the working second candidate', async () => {
    writeConfig(dead1, goodUrl);
    const res = await proxyToAgentTeams(req(), dead1, '/api/v1/teams', { forwardBody: false, method: 'GET' });
    expect(res.status).toBe(200);
    expect(goodCalls).toBe(1);
    // the working cache now points at the address that actually served
    expect(pickBackendUrl('controller')).toBe(goodUrl);
  });

  it('all candidates dead → 502 with per-address details', async () => {
    writeConfig(dead1, dead2);
    const res = await proxyToAgentTeams(req(), dead1, '/api/v1/teams', { forwardBody: false, method: 'GET' });
    expect(res.status).toBe(502);
    const data = (await res.json()) as { error: string; details: Array<{ url: string; error: string }> };
    expect(data.error).toContain('unreachable');
    expect(data.details.map((d) => d.url).sort()).toEqual([dead1, dead2].sort());
    // no working address may be marked from a fully failed round
    expect(effectiveUrl('controller')).toBeNull();
  });

  it('an HTTP 401 is returned as-is (no retry, not marked working)', async () => {
    writeConfig(authUrl, goodUrl);
    const res = await proxyToAgentTeams(req(), authUrl, '/api/v1/teams', { forwardBody: false, method: 'GET' });
    expect(res.status).toBe(401);
    expect(authCalls).toBe(1);
    expect(goodCalls).toBe(0);
    expect(effectiveUrl('controller')).toBeNull();
  });

  it('a valid ?controllerUrl= override pins a single address (no candidate walk)', async () => {
    writeConfig(dead1, goodUrl);
    const r1 = await proxyToAgentTeams(
      req(`?controllerUrl=${encodeURIComponent(goodUrl)}`),
      dead1,
      '/api/v1/teams',
      { forwardBody: false, method: 'GET' },
    );
    expect(r1.status).toBe(200);
    expect(goodCalls).toBe(1);

    // a dead override must NOT fall back to the config candidates
    const r2 = await proxyToAgentTeams(
      req(`?controllerUrl=${encodeURIComponent(dead2)}`),
      dead1,
      '/api/v1/teams',
      { forwardBody: false, method: 'GET' },
    );
    expect(r2.status).toBe(502);
    expect(goodCalls).toBe(1); // the good candidate was never walked
  });

  it('no config and no working cache → the passed primary is the single target', async () => {
    const res = await proxyToAgentTeams(req(), goodUrl, '/api/v1/teams', { forwardBody: false, method: 'GET' });
    expect(res.status).toBe(200);
    expect(goodCalls).toBe(1);
  });
});
