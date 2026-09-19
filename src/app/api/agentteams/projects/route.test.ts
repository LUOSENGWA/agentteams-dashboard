// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

async function callGet(routePath: string, controllerStatus: number, controllerBody: unknown) {
  vi.resetModules();
  vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', 'http://controller.test');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(controllerBody), {
        status: controllerStatus,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

  // Import the route fresh so proxy-helper reads the stubbed env.
  const route = await import('./route');
  const url = new URL(`http://dashboard.test${routePath}`);
  const response = await route.GET({
    method: 'GET',
    nextUrl: { pathname: url.pathname, searchParams: url.searchParams },
    headers: new Headers(),
  } as never);
  return response;
}

describe('GET /api/agentteams/projects (proxy)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('passes through a successful controller response', async () => {
    const res = await callGet('/api/agentteams/projects', 200, {
      projects: [{ project_id: 'p1', title: 'A', status: 'active' }],
      total: 1,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects).toHaveLength(1);
    expect(data.degraded).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      'http://controller.test/api/v1/projects',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('degrades to an empty list (200) when the controller API is missing (404)', async () => {
    const res = await callGet('/api/agentteams/projects', 404, { error: 'Not Found' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects).toEqual([]);
    expect(data.degraded).toBe(true);
    expect(data.degradedReason).toBe('api-not-deployed');
    expect(data.error).toContain('Not Found');
  });

  it('degrades to an empty list (200) on server error, marking controller-error', async () => {
    const res = await callGet('/api/agentteams/projects', 500, { error: 'boom' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects).toEqual([]);
    expect(data.degraded).toBe(true);
    expect(data.degradedReason).toBe('controller-error');
  });

  it('keeps the controller error message in the degraded body', async () => {
    const res = await callGet('/api/agentteams/projects', 500, { error: 'minio unreachable' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toContain('minio unreachable');
  });

  it('forwards query params to the controller and drops the internal controllerUrl override', async () => {
    const res = await callGet('/api/agentteams/projects?team=biz&controllerUrl=http://evil', 200, {
      projects: [],
      total: 0,
    });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      'http://controller.test/api/v1/projects?team=biz',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('GET /api/agentteams/projects (duplicate project rows)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('merges repeated project_id rows into one, keeping populated fields', async () => {
    // 线上实测形状：controller 按 plan/mode 记录返回，同一 project_id 出现两条，
    // 其中一条只有部分字段（空 team_id / plan_type / mode）。
    const res = await callGet('/api/agentteams/projects', 200, {
      projects: [
        {
          project_id: 'proj-20260820-121657',
          title: '赛博女儿智能体调用报告',
          status: 'active',
          plan_type: 'dag',
          team_id: 'team-xiaobai',
          mode: '',
        },
        { project_id: 'proj-20260820-121657', title: '赛博女儿智能体调用报告', status: 'active' },
        { project_id: 'scifi-drama-20260825', title: '科幻短剧剧情创作', status: 'active', team_id: 'videomake' },
      ],
      total: 3,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects).toHaveLength(2);
    expect(data.total).toBe(2);
    const merged = data.projects.find(
      (p: { project_id: string }) => p.project_id === 'proj-20260820-121657',
    );
    expect(merged).toMatchObject({ plan_type: 'dag', team_id: 'team-xiaobai' });
  });

  it('fills empty fields from later duplicate rows', async () => {
    const res = await callGet('/api/agentteams/projects', 200, {
      projects: [
        { project_id: 'p1', title: 'T', status: 'active', team_id: '', plan_type: '' },
        { project_id: 'p1', title: 'T', team_id: 'team-x', plan_type: 'dag', mode: 'auto' },
      ],
      total: 2,
    });
    const data = await res.json();
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0]).toMatchObject({ team_id: 'team-x', plan_type: 'dag', mode: 'auto' });
  });

  it('keeps records without a project_id as-is (no unsafe merge)', async () => {
    const res = await callGet('/api/agentteams/projects', 200, {
      projects: [{ title: 'a' }, { title: 'b' }],
      total: 2,
    });
    const data = await res.json();
    expect(data.projects).toHaveLength(2);
  });

  it('re-emits unexpected (non-array projects) bodies without failing', async () => {
    const res = await callGet('/api/agentteams/projects', 200, { error: 'unexpected shape' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toBe('unexpected shape');
  });
});
