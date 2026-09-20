import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  createSession,
  sessionCookieHeader,
  __resetSessionStoreForTests,
} from '@/lib/dashboard-session';
import { GET, PUT } from './route';

// 双平面 approval BFF 测试（9/18 v2 定案 + 评审修订：读写均 REST 优先；
// Docker 平面由 AGENTTEAMS_APPROVAL_DOCKER_PLANE 显式开启（默认关），仅 L1）。
// 场景矩阵：
//   GET: 新 Controller 200 / 旧 Controller 404→docker（flag on）/ L2+旧 403
//        （端点未上线）/ 不可见 Worker 404 / flag off + 旧 Controller 403
//   PUT: L1 REST 404→docker 全链（exec→轮询→rm 失败仍成功→回读验证）/
//        L1 REST 200（不调 Docker）/ L2 REST 200+回读 / 非法档位 400 /
//        REST 403（L2 OFF）/ REST 409 / 404 区分（不可见→防探测 404；
//        可见→端点未上线文案）

const SA_TOKEN = 'sa-token';
const CTL = 'http://controller.test';

interface Step {
  method?: string;
  match: RegExp;
  status: number;
  body?: unknown;
  text?: string;
  consumed?: boolean;
}

function makeFetch(steps: Step[]) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const step = steps.find(
      (s) => !s.consumed && s.match.test(url) && (!s.method || s.method === method),
    );
    if (!step) {
      throw new Error(`未预期的 fetch：${method} ${url}（steps: ${JSON.stringify(steps.map((s) => `${s.method ?? 'ANY'} ${s.match}`))}`);
    }
    step.consumed = true;
    return new Response(step.body !== undefined ? JSON.stringify(step.body) : (step.text ?? null), {
      status: step.status,
      headers: step.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    });
  });
  return { fn, assertAll: () => steps.forEach((s) => expect(s.consumed, `step 未消费：${s.method ?? 'ANY'} ${s.match}`).toBe(true)) };
}

function l2Cookie(): string {
  const { cookieValue } = createSession({
    user: 'bob',
    crLevel: 2,
    credential: { kind: 'matrix', token: 'dummy-matrix-token' },
  });
  return sessionCookieHeader(cookieValue);
}

function makeReq(name: string, opts?: { method?: string; body?: unknown; cookie?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts?.cookie) headers.cookie = opts.cookie;
  if (opts?.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`http://localhost/api/agentteams/workers/${name}/approval`, {
    method: opts?.method ?? 'GET',
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** 最小 tar：单文件成员（name + content），KB v2 ustar 同款可解析。 */
function makeTar(content: string, name = 'agent.json'): Buffer {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(data.length.toString(8).padStart(11, '0'), 124, 'utf8');
  header.write('0', 156);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(pad), Buffer.alloc(1024)]);
}

const AGENT_JSON = '/root/agentteams-fs/agents/%s/.qwenpaw/workspaces/default/agent.json';
const agentJsonPath = (name: string) => AGENT_JSON.replace('%s', name);
const archiveQs = (name: string) =>
  new RegExp(`/archive\\?path=${encodeURIComponent(agentJsonPath(name)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

function enableDockerPlane(): void {
  vi.stubEnv('AGENTTEAMS_APPROVAL_DOCKER_PLANE', '1');
}

beforeEach(() => {
  __resetSessionStoreForTests();
  vi.stubEnv('DASHBOARD_SESSION_SECRET', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', CTL);
  vi.stubEnv('AGENTTEAMS_AUTH_TOKEN', SA_TOKEN);
  vi.stubEnv('AGENTTEAMS_AUTH_TOKEN_FILE', '');
  vi.stubEnv('AGENTTEAMS_APPROVAL_DOCKER_PLANE', ''); // 默认关（评审修订）
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/agentteams/workers/[name]/approval', () => {
  it('新 Controller（REST 200）：直通，source=controller，档位大写归一', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'GET', match: /\/api\/v1\/workers\/w1\/approval$/, status: 200, body: { approval_level: 'smart' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await GET(makeReq('w1'), { params: Promise.resolve({ name: 'w1' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approval_level: 'SMART', source: 'controller' });
    assertAll();
  });

  it('旧 Controller（REST 404）→ Docker archive 兜底（L1 + flag on）', async () => {
    enableDockerPlane();
    const steps: Step[] = [
      { method: 'GET', match: /\/api\/v1\/workers\/w2\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/docker\/v1\.41\/containers\/agentteams-worker-w2\/json$/, status: 200, body: { Name: '/agentteams-worker-w2' } },
      { method: 'HEAD', match: archiveQs('w2'), status: 200 },
    ];
    // GET archive 返回 tar body——makeFetch 的 text 分支不支持 Buffer，单独处理：
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('archive?path=')) {
        steps[2].consumed = true;
        return new Response(new Uint8Array(makeTar(JSON.stringify({ approval_level: 'STRICT' }))), { status: 200 });
      }
      const step = steps.find(
        (st) => !st.consumed && st.match.test(url) && (!st.method || st.method === method),
      );
      if (!step) throw new Error(`未预期的 fetch：${method} ${url}`);
      step.consumed = true;
      return new Response(step.body !== undefined ? JSON.stringify(step.body) : null, { status: step.status });
    });
    vi.stubGlobal('fetch', fn);
    const res = await GET(makeReq('w2'), { params: Promise.resolve({ name: 'w2' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approval_level: 'STRICT', source: 'docker-archive' });
    steps.forEach((s) => expect(s.consumed).toBe(true));
  });

  it('L2 + 旧 Controller（REST 404）：Worker 在 scope 列表 → 403 端点未上线琥珀，不走 Docker', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'GET', match: /\/api\/v1\/workers\/w3\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/api\/v1\/workers$/, status: 200, body: [{ name: 'w3' }, { name: 'w4' }] },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await GET(makeReq('w3', { cookie: l2Cookie() }), { params: Promise.resolve({ name: 'w3' }) });
    expect(res.status).toBe(403);
    const data = (await res.json()) as { l2_hint?: string };
    expect(data.l2_hint).toMatch(/审批端点未上线/);
    assertAll(); // REST approval + 列表各一次——Docker 未被调用
  });

  it('L2 + REST 404 + Worker 不在 scope 列表（跨团队 W8）：404 隐藏（防探测）', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'GET', match: /\/api\/v1\/workers\/other-team\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/api\/v1\/workers$/, status: 200, body: [{ name: 'w3' }] },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await GET(makeReq('other-team', { cookie: l2Cookie() }), {
      params: Promise.resolve({ name: 'other-team' }),
    });
    expect(res.status).toBe(404);
    assertAll();
  });

  it('L1 + flag off + 旧 Controller（REST 404）：Worker 在列表 → 403 端点未上线（Docker 不启用）', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'GET', match: /\/api\/v1\/workers\/w2b\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/api\/v1\/workers$/, status: 200, body: { workers: [{ name: 'w2b' }], total: 1 } },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await GET(makeReq('w2b'), { params: Promise.resolve({ name: 'w2b' }) });
    expect(res.status).toBe(403);
    const data = (await res.json()) as { l2_hint?: string };
    expect(data.l2_hint).toMatch(/审批端点未上线/);
    assertAll();
  });

  it('Worker 缺失（REST 404 → 不在列表）：404 → UI 隐藏', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'GET', match: /\/api\/v1\/workers\/ghost\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/api\/v1\/workers$/, status: 200, body: [] },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await GET(makeReq('ghost'), { params: Promise.resolve({ name: 'ghost' }) });
    expect(res.status).toBe(404);
    assertAll();
  });
});

describe('PUT /api/agentteams/workers/[name]/approval', () => {
  it('L1 REST 200：直通（不调 Docker），回读验证', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'PUT', match: /\/api\/v1\/workers\/w1b\/approval$/, status: 200, body: {} },
      { method: 'GET', match: /\/api\/v1\/workers\/w1b\/approval$/, status: 200, body: { approval_level: 'AUTO' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('w1b', { method: 'PUT', body: { approval_level: 'SMART' } }), {
      params: Promise.resolve({ name: 'w1b' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, level: 'SMART', verified: 'AUTO', source: 'controller' });
    assertAll();
  });

  it('L1 REST 404（旧 Controller）+ flag on → Docker 全链：exec→start→轮询→rm→回读验证', async () => {
    enableDockerPlane();
    const steps: Step[] = [
      { method: 'PUT', match: /\/api\/v1\/workers\/w5\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'POST', match: /\/containers\/agentteams-worker-w5\/exec$/, status: 201, body: { Id: 'exec-1' } },
      { method: 'POST', match: /\/exec\/exec-1\/start$/, status: 204 },
      { method: 'GET', match: /\/archive\?path=%2Ftmp\/.at-appr-/, status: 200, text: '' }, // tar 轮询
      { method: 'POST', match: /\/containers\/agentteams-worker-w5\/exec$/, status: 201, body: { Id: 'exec-2' } },
      { method: 'POST', match: /\/exec\/exec-2\/start$/, status: 204 },
      { method: 'GET', match: /\/containers\/agentteams-worker-w5\/json$/, status: 200, body: { Name: '/agentteams-worker-w5' } },
      { method: 'HEAD', match: archiveQs('w5'), status: 200 },
    ];
    let pollCount = 0;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      // 两个 tar 返回：轮询结果文件 / 验证 agent.json
      if (method === 'GET' && url.includes('archive?path=')) {
        if (url.includes('.at-appr-')) {
          pollCount += 1;
          steps[3].consumed = true;
          return new Response(new Uint8Array(makeTar('OK SMART 200 {"ok":true}\nrc=0')), { status: 200 });
        }
        steps[7].consumed = true;
        return new Response(new Uint8Array(makeTar(JSON.stringify({ approval_level: 'SMART' }))), { status: 200 });
      }
      const step = steps.find(
        (s) => !s.consumed && s.match.test(url) && (!s.method || s.method === method),
      );
      if (!step) throw new Error(`未预期的 fetch：${method} ${url}`);
      step.consumed = true;
      return new Response(step.body !== undefined ? JSON.stringify(step.body) : null, { status: step.status });
    });
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('w5', { method: 'PUT', body: { approval_level: 'SMART' } }), {
      params: Promise.resolve({ name: 'w5' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, level: 'SMART', verified: 'SMART', source: 'docker-exec' });
    expect(pollCount).toBe(1); // 首轮即就位（rc= 出现）
    [0, 1, 2, 4, 5, 6].forEach((i) => expect(steps[i].consumed).toBe(true));
  });

  it('L1 Docker 全链：cleanup rm exec 失败（500）不影响写成功', async () => {
    enableDockerPlane();
    const steps: Step[] = [
      { method: 'PUT', match: /\/api\/v1\/workers\/w5c\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'POST', match: /\/containers\/agentteams-worker-w5c\/exec$/, status: 201, body: { Id: 'exec-1' } },
      { method: 'POST', match: /\/exec\/exec-1\/start$/, status: 204 },
      { method: 'GET', match: /\/archive\?path=%2Ftmp\/.at-appr-/, status: 200, text: '' },
      { method: 'POST', match: /\/containers\/agentteams-worker-w5c\/exec$/, status: 500, body: { message: 'rm exec failed' } }, // cleanup 失败
      { method: 'GET', match: /\/containers\/agentteams-worker-w5c\/json$/, status: 200, body: { Name: '/agentteams-worker-w5c' } },
      { method: 'HEAD', match: archiveQs('w5c'), status: 200 },
    ];
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('archive?path=')) {
        if (url.includes('.at-appr-')) {
          steps[3].consumed = true;
          return new Response(new Uint8Array(makeTar('OK OFF 200 {"ok":true}\nrc=0')), { status: 200 });
        }
        steps[6].consumed = true;
        return new Response(new Uint8Array(makeTar(JSON.stringify({ approval_level: 'OFF' }))), { status: 200 });
      }
      const step = steps.find(
        (s) => !s.consumed && s.match.test(url) && (!s.method || s.method === method),
      );
      if (!step) throw new Error(`未预期的 fetch：${method} ${url}`);
      step.consumed = true;
      return new Response(step.body !== undefined ? JSON.stringify(step.body) : null, { status: step.status });
    });
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('w5c', { method: 'PUT', body: { approval_level: 'OFF' } }), {
      params: Promise.resolve({ name: 'w5c' }),
    });
    expect(res.status).toBe(200); // cleanup 失败无害——写仍成功
    expect(await res.json()).toEqual({ ok: true, level: 'OFF', verified: 'OFF', source: 'docker-exec' });
    [0, 1, 2, 3, 4, 5].forEach((i) => expect(steps[i].consumed).toBe(true));
  });

  it('L2 直接 REST（不调 Docker）：200 + 回读验证', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'PUT', match: /\/api\/v1\/workers\/w6\/approval$/, status: 200, body: {} },
      { method: 'GET', match: /\/api\/v1\/workers\/w6\/approval$/, status: 200, body: { approval_level: 'STRICT' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('w6', { method: 'PUT', body: { approval_level: 'strict' }, cookie: l2Cookie() }), {
      params: Promise.resolve({ name: 'w6' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, level: 'STRICT', verified: 'STRICT', source: 'controller' });
    assertAll();
  });

  it('非法档位：400，零上游调用', async () => {
    const { fn, assertAll } = makeFetch([]);
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('w7', { method: 'PUT', body: { approval_level: 'YOLO' } }), {
      params: Promise.resolve({ name: 'w7' }),
    });
    expect(res.status).toBe(400);
    const data400 = (await res.json()) as { error: string };
    expect(data400.error).toMatch(/STRICT \/ SMART \/ AUTO \/ OFF/);
    assertAll();
  });

  it('L2 REST 403（设 OFF / team leader）：403 + 文案', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'PUT', match: /\/api\/v1\/workers\/w8\/approval$/, status: 403, body: { detail: 'cannot set OFF' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('w8', { method: 'PUT', body: { approval_level: 'OFF' }, cookie: l2Cookie() }), {
      params: Promise.resolve({ name: 'w8' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('cannot set OFF');
    assertAll();
  });

  it('L2 REST 409（并发冲突）：409 + 重试提示', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'PUT', match: /\/api\/v1\/workers\/w9\/approval$/, status: 409, body: { detail: 'busy' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('w9', { method: 'PUT', body: { approval_level: 'AUTO' }, cookie: l2Cookie() }), {
      params: Promise.resolve({ name: 'w9' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/并发冲突/);
    assertAll();
  });

  it('L2 REST 404 + Worker 不可见（跨团队 W8）：404 防探测文案', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'PUT', match: /\/api\/v1\/workers\/other-team\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/api\/v1\/workers$/, status: 200, body: [{ name: 'w6' }] },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('other-team', { method: 'PUT', body: { approval_level: 'AUTO' }, cookie: l2Cookie() }), {
      params: Promise.resolve({ name: 'other-team' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toMatch(/不存在或无权限/);
    assertAll();
  });

  it('L2 REST 404 + Worker 在 scope 列表：404 端点未上线文案', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'PUT', match: /\/api\/v1\/workers\/w10\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/api\/v1\/workers$/, status: 200, body: [{ name: 'w10' }] },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('w10', { method: 'PUT', body: { approval_level: 'AUTO' }, cookie: l2Cookie() }), {
      params: Promise.resolve({ name: 'w10' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toMatch(/审批端点未上线/);
    assertAll();
  });

  it('L1 REST 404 + flag off + Worker 在列表：404 端点未上线 + flag 提示', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'PUT', match: /\/api\/v1\/workers\/w11\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/api\/v1\/workers$/, status: 200, body: [{ name: 'w11' }] },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('w11', { method: 'PUT', body: { approval_level: 'AUTO' } }), {
      params: Promise.resolve({ name: 'w11' }),
    });
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/审批端点未上线/);
    expect(data.error).toMatch(/AGENTTEAMS_APPROVAL_DOCKER_PLANE=1/);
    assertAll();
  });
});
