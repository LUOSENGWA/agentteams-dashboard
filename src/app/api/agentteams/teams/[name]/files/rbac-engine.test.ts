import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 真实 RBAC 引擎（enforceServerSideRbac 不 mock），只替换 IO 边界：
// minio-client 与 audit-log。验证路由 + server-auth + rbac-engine 的
// 端到端门控行为（SEC-01/02/03 统一验收）。
const { listObjects, statObject, getObject } = vi.hoisted(() => ({
  listObjects: vi.fn(),
  statObject: vi.fn(),
  getObject: vi.fn(),
}));

vi.mock('@/lib/minio-client', () => ({
  createMinioClient: () => ({ listObjects, statObject, getObject }),
  getMinioBucket: () => 'agentteams-fs',
}));

const appendAudit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/audit-log', () => ({ appendAuditEvent: appendAudit }));

const { SERVER_USER_HEADER, SERVER_USER_LEVEL_HEADER } = await import('@/lib/server-auth');

function request(url: string, level?: number): NextRequest {
  const headers: Record<string, string> = {};
  if (level !== undefined) {
    headers[SERVER_USER_HEADER] = `user-${level}`;
    headers[SERVER_USER_LEVEL_HEADER] = String(level);
  }
  return new NextRequest(url, { headers });
}

function makeListStream(items: Array<Record<string, unknown>>) {
  return {
    on: vi.fn(function on(this: unknown, event: string, cb: (..._args: unknown[]) => void) {
      if (event === 'data') {
        for (const item of items) setImmediate(() => cb(item));
      }
      if (event === 'end') setImmediate(() => cb());
      return this;
    }),
  } as never;
}

async function listFiles(name: string, level?: number) {
  const { GET } = await import('./route');
  return GET(request('http://localhost/', level), { params: Promise.resolve({ name }) });
}

async function download(name: string, key: string, level?: number) {
  const { GET } = await import('./download/route');
  return GET(request(`http://localhost/?key=${encodeURIComponent(key)}`, level), {
    params: Promise.resolve({ name }),
  });
}

describe('teams files 读路由 × 真实 RBAC 引擎（SEC-03 端到端）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('level 1 观察者（view 权限）可列出 team 文件', async () => {
    listObjects.mockImplementation(() =>
      makeListStream([{ name: 'teams/t1/shared/README.md', size: 5 }]),
    );
    const res = await listFiles('t1', 1);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.objects).toHaveLength(1);
  });

  it('level 3 管理员可列出 team 文件', async () => {
    const res = await listFiles('t1', 3);
    expect(res.status).toBe(200);
  });

  it('level 1 可下载非敏感文件', async () => {
    statObject.mockResolvedValue({ metaData: {}, size: 5 });
    getObject.mockResolvedValue(new Readable());
    const res = await download('t1', 'teams/t1/shared/README.md', 1);
    expect(res.status).toBe(200);
    expect(appendAudit).not.toHaveBeenCalled();
  });

  it('level 1 下载敏感文件 → 404，不触发审计（过滤先于存在性）', async () => {
    const res = await download('t1', 'teams/t1/shared/credentials.yaml', 1);
    expect(res.status).toBe(404);
    expect(statObject).not.toHaveBeenCalled();
  });

  it('level 1 下载 .ssh 嵌套敏感文件 → 404', async () => {
    const res = await download('t1', 'teams/t1/home/.ssh/id_rsa', 1);
    expect(res.status).toBe(404);
  });

  it('无身份头（middleware 之外）默认按 level 1 放行 view，维持现状语义', async () => {
    const res = await listFiles('t1');
    expect(res.status).toBe(200);
  });
});
