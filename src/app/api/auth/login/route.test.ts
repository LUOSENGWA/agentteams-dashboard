import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { callHigressConsole, forwardCookies } from '../../higress/proxy-helper';
import { getAuthToken, getControllerUrl } from '../../agentteams/proxy-helper';
import { __resetSessionStoreForTests, SESSION_COOKIE_NAME } from '@/lib/dashboard-session';

vi.mock('../../higress/proxy-helper', () => ({
  callHigressConsole: vi.fn(),
  forwardCookies: vi.fn((from: Headers, to: Headers) => {
    for (const cookie of from.getSetCookie()) {
      to.append('set-cookie', cookie);
    }
  }),
  getHigressConsoleURL: vi.fn(() => 'http://higress-console:8080'),
}));

vi.mock('../../agentteams/proxy-helper', () => ({
  getAuthToken: vi.fn(async () => 'sa-token'),
  getControllerUrl: vi.fn(() => 'http://controller.test:8090'),
}));

vi.mock('@/lib/homeserver-allowlist', () => ({
  validateHomeserverUrl: vi.fn(),
}));

const mockCallHigressConsole = vi.mocked(callHigressConsole);
const mockForwardCookies = vi.mocked(forwardCookies);
const mockGetAuthToken = vi.mocked(getAuthToken);
const mockGetControllerUrl = vi.mocked(getControllerUrl);

const SECRET = 'c'.repeat(64);

function request(body: Record<string, unknown>) {
  return new NextRequest('http://dashboard.test/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function successfulConsoleLogin() {
  return {
    response: new Response(null, { status: 200, headers: { 'set-cookie': '_hi_sess=abc; Path=/; HttpOnly' } }),
    body: { success: true },
  };
}

function failedConsoleLogin() {
  return {
    response: new Response(null, { status: 401 }),
    body: { error: 'bad' },
  };
}

/** fetch mock router: SA human lookup + Matrix login, default 401. */
function installFetchMock(opts: {
  humans?: Record<string, { status?: number; body?: Record<string, unknown> }>;
  matrixLogin?: { status?: number; body?: Record<string, unknown> };
  teamsCheck?: { status?: number };
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    void init;
    const humanMatch = url.match(/\/api\/v1\/humans\/([^/]+)$/);
    if (humanMatch) {
      const spec = opts.humans?.[decodeURIComponent(humanMatch[1])] ?? { status: 404 };
      return new Response(spec.status ? null : JSON.stringify(spec.body ?? {}), {
        status: spec.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/v1/teams')) {
      const status = opts.teamsCheck?.status ?? 200;
      return new Response(null, { status, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/_matrix/client/v3/login')) {
      const spec = opts.matrixLogin ?? { status: 401 };
      return new Response(spec.status ? null : JSON.stringify(spec.body ?? {}), {
        status: spec.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status: 401 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json();
}

describe('POST /api/auth/login (dual track, M19)', () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    vi.stubEnv('DASHBOARD_SESSION_SECRET', SECRET);
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'direct');
    vi.stubEnv('DASHBOARD_COOKIE_SECURE', '');
    mockCallHigressConsole.mockReset();
    mockForwardCookies.mockReset();
    mockGetAuthToken.mockReset();
    mockGetAuthToken.mockResolvedValue('sa-token');
    mockGetControllerUrl.mockReset();
    mockGetControllerUrl.mockReturnValue('http://controller.test:8090');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('L1: Console login → level-3 session, identity = the Console username (admin ≠ luo), SA credential, both cookies', async () => {
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    const fetchMock = installFetchMock({ matrixLogin: { status: 401 } });

    const response = await POST(request({ username: 'admin', password: 'password' }));
    expect(response.status).toBe(200);
    const data = await responseJson(response);
    expect(data.success).toBe(true);
    // Identity is the Console account itself — NOT remapped to a Human CR.
    expect(data.user).toEqual({ username: 'admin', level: 3 });
    expect(data.mode).toBe('higress');
    expect(data.matrix).toBeNull();

    // No Human CR lookup on the Console track.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/api/v1/humans/'))).toBe(true);

    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith('_hi_sess='))).toBe(true);
  });

  it('L1: session secret missing → fail closed (503, no cookie)', async () => {
    vi.stubEnv('DASHBOARD_SESSION_SECRET', '');
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    installFetchMock({ matrixLogin: { status: 401 } });

    const response = await POST(request({ username: 'admin', password: 'password' }));
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('Matrix: Console 401 + Matrix login + CR level 2 (sunzong) → level-2 session, scoped, matrix mode, no Console cookie', async () => {
    mockCallHigressConsole.mockResolvedValue(failedConsoleLogin());
    installFetchMock({
      humans: { sunzong: { body: { name: 'sunzong', permissionLevel: 2, accessibleTeams: ['biz-team'] } } },
      matrixLogin: {
        body: { access_token: 'syt_l2_token', user_id: '@sunzong:sat.example', device_id: 'D1' },
      },
    });

    // L2 users ignore a pasted controller token (their Matrix token is the
    // data-plane credential) — passing one must not break the login.
    const response = await POST(
      request({ username: 'sunzong', password: 'matrix-password', controllerToken: 'should-be-ignored' }),
    );
    expect(response.status).toBe(200);
    const data = await responseJson(response);
    expect(data.success).toBe(true);
    expect(data.user).toEqual({ username: 'sunzong', level: 2 });
    expect(data.mode).toBe('matrix');
    expect((data.matrix as { accessToken?: string }).accessToken).toBe('syt_l2_token');

    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith('_hi_sess='))).toBe(false);
    // The Matrix token must never appear in a cookie value.
    expect(cookies.every((c) => !c.includes('syt_l2_token'))).toBe(true);
  });

  it('Matrix: CR level 1 (luo) + valid controller token → level-3 session, matrix chat token kept', async () => {
    mockCallHigressConsole.mockResolvedValue(failedConsoleLogin());
    const fetchMock = installFetchMock({
      humans: {
        luo: {
          body: { name: 'luo', permissionLevel: 1, accessibleTeams: ['sysdev-team', 'embedded-team'] },
        },
      },
      matrixLogin: {
        body: { access_token: 'syt_l1_token', user_id: '@luo:sat.example', device_id: 'D2' },
      },
      teamsCheck: { status: 200 },
    });

    const response = await POST(
      request({ username: 'luo', password: 'matrix-password', controllerToken: 'cli-admin-token' }),
    );
    expect(response.status).toBe(200);
    const data = await responseJson(response);
    expect(data.success).toBe(true);
    expect(data.user).toEqual({ username: 'luo', level: 3 });
    expect(data.mode).toBe('matrix');
    // The Matrix token is still returned for the chat tab.
    expect((data.matrix as { accessToken?: string }).accessToken).toBe('syt_l1_token');
    // The pasted token was verified against the Controller.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/v1/teams'))).toBe(true);
    // The pasted admin token must never leak into a cookie.
    expect(response.headers.getSetCookie().every((c) => !c.includes('cli-admin-token'))).toBe(true);
  });

  it('Matrix: CR level 1 (luo) WITHOUT controller token → 400 with a clear hint', async () => {
    mockCallHigressConsole.mockResolvedValue(failedConsoleLogin());
    installFetchMock({
      humans: { luo: { body: { name: 'luo', permissionLevel: 1 } } },
      matrixLogin: {
        body: { access_token: 'syt_l1_token', user_id: '@luo:sat.example', device_id: 'D2' },
      },
    });

    const response = await POST(request({ username: 'luo', password: 'matrix-password' }));
    expect(response.status).toBe(400);
    const data = await responseJson(response);
    expect(data.success).toBe(false);
    expect(String(data.error)).toContain('Controller');
  });

  it('Matrix: CR level 1 (luo) + INVALID controller token → 401', async () => {
    mockCallHigressConsole.mockResolvedValue(failedConsoleLogin());
    installFetchMock({
      humans: { luo: { body: { name: 'luo', permissionLevel: 1 } } },
      matrixLogin: {
        body: { access_token: 'syt_l1_token', user_id: '@luo:sat.example', device_id: 'D2' },
      },
      teamsCheck: { status: 401 },
    });

    const response = await POST(
      request({ username: 'luo', password: 'matrix-password', controllerToken: 'wrong-token' }),
    );
    expect(response.status).toBe(401);
  });

  it('Matrix: CR level 3 (observer) → level-1 session', async () => {
    mockCallHigressConsole.mockResolvedValue(failedConsoleLogin());
    installFetchMock({
      humans: { watcher: { body: { name: 'watcher', permissionLevel: 3 } } },
      matrixLogin: {
        body: { access_token: 't3', user_id: '@watcher:sat.example', device_id: 'D3' },
      },
    });

    const response = await POST(request({ username: 'watcher', password: 'x' }));
    expect(response.status).toBe(200);
    const data = await responseJson(response);
    expect(data.user).toEqual({ username: 'watcher', level: 1 });
    expect(data.mode).toBe('matrix');
  });

  it('Matrix: login ok but no Human CR (non-human account) → 401 (no level leak)', async () => {
    mockCallHigressConsole.mockResolvedValue(failedConsoleLogin());
    installFetchMock({
      humans: {},
      matrixLogin: {
        body: { access_token: 't', user_id: '@randomuser:sat.example', device_id: 'D' },
      },
    });

    const response = await POST(request({ username: 'randomuser', password: 'x' }));
    expect(response.status).toBe(401);
    const data = await responseJson(response);
    expect(data.success).toBe(false);
  });

  it('both tracks fail → 401', async () => {
    mockCallHigressConsole.mockResolvedValue(failedConsoleLogin());
    installFetchMock({ humans: {}, matrixLogin: { status: 401 } });

    const response = await POST(request({ username: 'nobody', password: 'x' }));
    expect(response.status).toBe(401);
    const data = await responseJson(response);
    expect(data.success).toBe(false);
  });

  it('never calls /system/init (auto-registration removed — fresh-Console privilege escalation)', async () => {
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    installFetchMock({ matrixLogin: { status: 401 } });

    await POST(request({ username: 'admin', password: 'password' }));
    expect(mockCallHigressConsole).toHaveBeenCalledTimes(1);
    expect(mockCallHigressConsole).not.toHaveBeenCalledWith('/system/init', expect.anything());
  });

  it('external mode: no init, no Matrix token returned, session still created for L1', async () => {
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'external');
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    installFetchMock({
      matrixLogin: { body: { access_token: 'secret-matrix', user_id: '@admin:sat.example', device_id: 'D' } },
    });

    const response = await POST(request({ username: 'admin', password: 'password' }));
    expect(response.status).toBe(200);
    expect(mockCallHigressConsole).toHaveBeenCalledTimes(1);
    expect(mockCallHigressConsole).toHaveBeenCalledWith('/session/login', expect.anything());
    const data = await responseJson(response);
    expect(data.matrix).toBeNull();
    expect(JSON.stringify(data)).not.toContain('secret-matrix');
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
  });
});
