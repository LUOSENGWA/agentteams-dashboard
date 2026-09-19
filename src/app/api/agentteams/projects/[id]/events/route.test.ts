// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

async function callGet(projectId: string, controllerStatus: number, query = '') {
  vi.resetModules();
  vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', 'http://controller.test');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          project_id: projectId,
          events: [],
          next_cursor: '',
        }),
        { status: controllerStatus },
      ),
    ),
  );

  const route = await import('./route');
  const response = await route.GET(
    {
      method: 'GET',
      nextUrl: {
        pathname: `/api/agentteams/projects/${projectId}/events`,
        searchParams: new URLSearchParams(query),
      },
      headers: new Headers(),
    } as never,
    { params: Promise.resolve({ id: projectId }) },
  );
  return response;
}

describe('GET /api/agentteams/projects/[id]/events (proxy)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('proxies to the canonical controller path', async () => {
    const res = await callGet('p1', 200);
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'http://controller.test/api/v1/projects/p1/events',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('forwards limit/cursor/team and drops controllerUrl', async () => {
    await callGet('p1', 200, 'team=biz-team&limit=100&cursor=abc123&controllerUrl=http://evil');
    expect(fetch).toHaveBeenCalledWith(
      'http://controller.test/api/v1/projects/p1/events?team=biz-team&limit=100&cursor=abc123',
      expect.anything(),
    );
  });

  it('encodes the project id in the proxied path', async () => {
    await callGet('a/b c', 200);
    expect(fetch).toHaveBeenCalledWith(
      'http://controller.test/api/v1/projects/a%2Fb%20c/events',
      expect.anything(),
    );
  });

  it('passes through 404 (project missing / endpoint not deployed yet)', async () => {
    const res = await callGet('ghost', 404);
    expect(res.status).toBe(404);
  });

  it('passes through 403 cross-team', async () => {
    const res = await callGet('p1', 403);
    expect(res.status).toBe(403);
  });

  it('passes through 400 invalid cursor', async () => {
    const res = await callGet('p1', 400, 'cursor=%zz');
    expect(res.status).toBe(400);
  });
});
