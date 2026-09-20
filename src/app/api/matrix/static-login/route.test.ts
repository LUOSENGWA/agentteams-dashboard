import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as staticLogin } from './route';

// Review pin: MATRIX_HOMESERVER_ALLOWLIST is a hard requirement for the
// stateless credential-bearing proxy routes. Unset → 403
// 'allowlist-not-configured' (login refused outright, no upstream call);
// set → requireAllowlist validation (only operator-approved hosts).

const LOGIN_URL = 'http://localhost/api/matrix/static-login';

function makeReq(body: unknown): NextRequest {
  return new NextRequest(LOGIN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('MATRIX_HOMESERVER_ALLOWLIST', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/matrix/static-login — allowlist hard requirement', () => {
  it('MATRIX_HOMESERVER_ALLOWLIST 未设：403 allowlist-not-configured，零上游调用', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await staticLogin(
      makeReq({ homeserver: 'http://matrix.local:6167', username: 'alice', password: 'secret' }),
    );
    expect(res.status).toBe(403);
    const data = (await res.json()) as { reason?: string; error?: string };
    expect(data.reason).toBe('allowlist-not-configured');
    expect(data.error).toMatch(/MATRIX_HOMESERVER_ALLOWLIST/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allowlist 已设且主机在列：放行到上游（LAN homeserver 正常登录）', async () => {
    vi.stubEnv('MATRIX_HOMESERVER_ALLOWLIST', 'matrix.local');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ user_id: '@alice:matrix.local', access_token: 'mtx-tok', device_id: 'DEV1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch,
    );
    const res = await staticLogin(
      makeReq({ homeserver: 'http://matrix.local:6167', username: 'alice', password: 'secret' }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { access_token?: string };
    expect(data.access_token).toBe('mtx-tok');
  });

  it('allowlist 已设但主机不在列：403（requireAllowlist 排他校验，零上游调用）', async () => {
    vi.stubEnv('MATRIX_HOMESERVER_ALLOWLIST', 'matrix.local');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await staticLogin(
      makeReq({ homeserver: 'http://evil.example.com', username: 'alice', password: 'secret' }),
    );
    expect(res.status).toBe(403);
    const data = (await res.json()) as { reason?: string };
    expect(data.reason).toBe('host is not in the allowlist');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
