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

/** fetch mock router: SA human lookup + Matrix login, default 401. */
function installFetchMock(opts: {
  humans?: Record<string, { status?: number; body?: Record<string, unknown> }>;
  matrixLogin?: { status?: number; body?: Record<string, unknown> };
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
    vi.stubEnv('DASHBOARD_L1_HUMAN', '');
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

  it('L1: Console login + Human CR level 1 → level-3 session, SA credential, both cookies', async () => {
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    installFetchMock({
      humans: { luo: { body: { name: 'luo', permissionLevel: 1, accessibleTeams: ['a', 'b'] } } },
      matrixLogin: { status: 401 },
    });

    const response = await POST(request({ username: 'admin', password: 'password' }));
    expect(response.status).toBe(200);
    const data = await responseJson(response);
    expect(data.success).toBe(true);
    expect(data.user).toEqual({ username: 'luo', level: 3 });
    expect(data.mode).toBe('higress');
    expect(data.matrix).toBeNull();

    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith('_hi_sess='))).toBe(true);
  });

  it('L1: honors DASHBOARD_L1_HUMAN for the CR lookup', async () => {
    vi.stubEnv('DASHBOARD_L1_HUMAN', 'luo');
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    const fetchMock = installFetchMock({
      humans: { luo: { body: { name: 'luo', permissionLevel: 1 } } },
      matrixLogin: { status: 401 },
    });

    const response = await POST(request({ username: 'admin', password: 'password' }));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://controller.test:8090/api/v1/humans/luo',
      expect.objectContaining({ headers: { Authorization: 'Bearer sa-token' } }),
    );
  });

  it('L1: Console ok but CR missing → 503 misconfigured (fail loudly)', async () => {
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    installFetchMock({ humans: {}, matrixLogin: { status: 401 } });

    const response = await POST(request({ username: 'admin', password: 'password' }));
    expect(response.status).toBe(503);
  });

  it('L1: Console ok but CR is level 2 → 503 (not silently demoted)', async () => {
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    installFetchMock({
      humans: { luo: { body: { name: 'luo', permissionLevel: 2 } } },
      matrixLogin: { status: 401 },
    });

    const response = await POST(request({ username: 'admin', password: 'password' }));
    expect(response.status).toBe(503);
  });

  it('L1: session secret missing → fail closed (503, no cookie)', async () => {
    vi.stubEnv('DASHBOARD_SESSION_SECRET', '');
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    installFetchMock({
      humans: { luo: { body: { name: 'luo', permissionLevel: 1 } } },
      matrixLogin: { status: 401 },
    });

    const response = await POST(request({ username: 'admin', password: 'password' }));
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('L2: Console 401 + Matrix login + CR level 2 → level-2 session, matrix mode, no Console cookie', async () => {
    mockCallHigressConsole.mockResolvedValue({
      response: new Response(null, { status: 401 }),
      body: { error: 'bad' },
    });
    installFetchMock({
      humans: { sunzong: { body: { name: 'sunzong', permissionLevel: 2, accessibleTeams: ['biz-team'] } } },
      matrixLogin: {
        body: { access_token: 'syt_l2_token', user_id: '@sunzong:sat.example', device_id: 'D1' },
      },
    });

    const response = await POST(request({ username: 'sunzong', password: 'matrix-password' }));
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

  it('L2: CR level 1 (admin human) via Matrix → 401 (L1 must use the Console track)', async () => {
    mockCallHigressConsole.mockResolvedValue({
      response: new Response(null, { status: 401 }),
      body: { error: 'bad' },
    });
    installFetchMock({
      humans: { luo: { body: { name: 'luo', permissionLevel: 1 } } },
      matrixLogin: { body: { access_token: 't', user_id: '@luo:sat.example', device_id: 'D' } },
    });

    const response = await POST(request({ username: 'luo', password: 'x' }));
    expect(response.status).toBe(401);
  });

  it('both tracks fail → 401', async () => {
    mockCallHigressConsole.mockResolvedValue({
      response: new Response(null, { status: 401 }),
      body: { error: 'bad' },
    });
    installFetchMock({ humans: {}, matrixLogin: { status: 401 } });

    const response = await POST(request({ username: 'nobody', password: 'x' }));
    expect(response.status).toBe(401);
    const data = await responseJson(response);
    expect(data.success).toBe(false);
  });

  it('never calls /system/init (auto-registration removed — fresh-Console privilege escalation)', async () => {
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    installFetchMock({
      humans: { luo: { body: { name: 'luo', permissionLevel: 1 } } },
      matrixLogin: { status: 401 },
    });

    await POST(request({ username: 'admin', password: 'password' }));
    expect(mockCallHigressConsole).toHaveBeenCalledTimes(1);
    expect(mockCallHigressConsole).not.toHaveBeenCalledWith(
      '/system/init',
      expect.anything(),
    );
  });

  it('external mode: no init, no Matrix token returned, session still created for L1', async () => {
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'external');
    mockCallHigressConsole.mockResolvedValue(successfulConsoleLogin());
    installFetchMock({
      humans: { luo: { body: { name: 'luo', permissionLevel: 1 } } },
      matrixLogin: { body: { access_token: 'secret-matrix', user_id: '@luo:sat.example', device_id: 'D' } },
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
