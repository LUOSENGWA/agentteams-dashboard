import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as deleteDevices } from './route';

// Review pin: same hard allowlist requirement as static-login — the device
// access token must only ever reach an operator-approved host; unset list →
// 403 'allowlist-not-configured', zero upstream calls.

const URL_ = 'http://localhost/api/matrix/delete-devices';

function makeReq(body: unknown, token = 'mtx-tok'): NextRequest {
  return new NextRequest(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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

describe('POST /api/matrix/delete-devices — allowlist hard requirement', () => {
  it('MATRIX_HOMESERVER_ALLOWLIST 未设：403 allowlist-not-configured，零上游调用', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await deleteDevices(makeReq({ homeserver: 'http://matrix.local:6167', deviceId: 'DEV1' }));
    expect(res.status).toBe(403);
    const data = (await res.json()) as { reason?: string; error?: string };
    expect(data.reason).toBe('allowlist-not-configured');
    expect(data.error).toMatch(/MATRIX_HOMESERVER_ALLOWLIST/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allowlist 已设且主机在列：放行到上游', async () => {
    vi.stubEnv('MATRIX_HOMESERVER_ALLOWLIST', 'matrix.local');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }),
      ) as unknown as typeof fetch,
    );
    const res = await deleteDevices(makeReq({ homeserver: 'http://matrix.local:6167', deviceId: 'DEV1' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success?: boolean }).success).toBe(true);
  });
});
