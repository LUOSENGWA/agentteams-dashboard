import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  createSession,
  sessionCookieHeader,
  __resetSessionStoreForTests,
} from '@/lib/dashboard-session';
import { GET, PUT } from './route';

// 双平面 approval BFF 测试（9/18 v2 定案：读 REST 优先→Docker 兜底；
// 写 L1 Docker 优先 / L2 直接 REST）。
// 场景矩阵：
//   GET: 新 Controller 200 / 旧 Controller 404→docker / L2+旧 403 / worker 缺失 404
//   PUT: L1 docker 全链（exec→轮询→rm→回读验证）/ L2 REST 200+回读 /
//        非法档位 400 / REST 403（L2 OFF）/ REST 409 / worker 缺失 404

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
const archiveQs = (name: string) => `/archive?path=${encodeURIComponent(agentJsonPath(name))}`;

beforeEach(() => {
  __resetSessionStoreForTests();
  vi.stubEnv('DASHBOARD_SESSION_SECRET', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', CTL);
  vi.stubEnv('AGENTTEAMS_AUTH_TOKEN', SA_TOKEN);
  vi.stubEnv('AGENTTEAMS_AUTH_TOKEN_FILE', '');
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

  it('旧 Controller（REST 404）→ Docker archive 兜底（L1）', async () => {
    const steps: Step[] = [
      { method: 'GET', match: /\/api\/v1\/workers\/w2\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/docker\/v1\.41\/containers\/agentteams-worker-w2\/json$/, status: 200, body: { Name: '/agentteams-worker-w2' } },
      { method: 'HEAD', match: new RegExp(archiveQs('w2').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), status: 200 },
      { method: 'GET', match: new RegExp(archiveQs('w2').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), status: 200, text: '' },
    ];
    // 第 4 步（GET archive）返回 tar body——makeFetch 的 text 分支不支持 Buffer，单独处理：
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('archive?path=')) {
        const s = steps[3];
        s.consumed = true;
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

  it('L2 + 旧 Controller（REST 404）：403 + l2_hint，不走 Docker（防越权）', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'GET', match: /\/api\/v1\/workers\/w3\/approval$/, status: 404, body: { detail: 'not found' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await GET(makeReq('w3', { cookie: l2Cookie() }), { params: Promise.resolve({ name: 'w3' }) });
    expect(res.status).toBe(403);
    const data = (await res.json()) as { l2_hint?: string };
    expect(data.l2_hint).toMatch(/L2 账号无权限读取/);
    assertAll(); // 仅 REST 一次——Docker 未被调用
  });

  it('Worker 缺失（REST 404 → 容器 inspect 404）：404 → UI 隐藏', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'GET', match: /\/api\/v1\/workers\/ghost\/approval$/, status: 404, body: { detail: 'not found' } },
      { method: 'GET', match: /\/docker\/v1\.41\/containers\/agentteams-worker-ghost\/json$/, status: 404, body: { message: 'no such container' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await GET(makeReq('ghost'), { params: Promise.resolve({ name: 'ghost' }) });
    expect(res.status).toBe(404);
    assertAll();
  });
});

describe('PUT /api/agentteams/workers/[name]/approval', () => {
  it('L1 Docker 全链：exec→start→轮询→rm→回读验证（live 生效）', async () => {
    const steps: Step[] = [
      { method: 'POST', match: /\/containers\/agentteams-worker-w5\/exec$/, status: 201, body: { Id: 'exec-1' } },
      { method: 'POST', match: /\/exec\/exec-1\/start$/, status: 204 },
      { method: 'GET', match: /\/archive\?path=%2Ftmp\/.at-appr-/, status: 200, text: '' }, // tar 轮询
      { method: 'POST', match: /\/containers\/agentteams-worker-w5\/exec$/, status: 201, body: { Id: 'exec-2' } },
      { method: 'POST', match: /\/exec\/exec-2\/start$/, status: 204 },
      { method: 'GET', match: /\/containers\/agentteams-worker-w5\/json$/, status: 200, body: { Name: '/agentteams-worker-w5' } },
      { method: 'HEAD', match: new RegExp(archiveQs('w5').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), status: 200 },
      { method: 'GET', match: new RegExp(archiveQs('w5').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), status: 200, text: '' },
    ];
    let pollCount = 0;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      // 两个 tar 返回：轮询结果文件 / 验证 agent.json
      if (method === 'GET' && url.includes('archive?path=')) {
        if (url.includes('.at-appr-')) {
          pollCount += 1;
          steps[2].consumed = true;
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
    [0, 1, 3, 4, 5, 6].forEach((i) => expect(steps[i].consumed).toBe(true));
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

  it('Worker 缺失（Docker exec 404）：404，不回落 REST', async () => {
    const { fn, assertAll } = makeFetch([
      { method: 'POST', match: /\/containers\/agentteams-worker-ghost2\/exec$/, status: 404, body: { message: 'no such container' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const res = await PUT(makeReq('ghost2', { method: 'PUT', body: { approval_level: 'AUTO' } }), {
      params: Promise.resolve({ name: 'ghost2' }),
    });
    expect(res.status).toBe(404);
    assertAll();
  });
});
