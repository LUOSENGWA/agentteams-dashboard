import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const { listObjects, statObject, getObject } = vi.hoisted(() => ({
  listObjects: vi.fn(),
  statObject: vi.fn(),
  getObject: vi.fn(),
}));

vi.mock('@/lib/minio-client', () => ({
  createMinioClient: () => ({ listObjects, statObject, getObject }),
  getMinioBucket: () => 'agentteams-fs',
}));

const rbacMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server-auth', () => ({
  enforceServerSideRbac: (...args: unknown[]) => rbacMock(...args),
}));

const denied = new NextResponse(JSON.stringify({ success: false, error: 'rbac.deny' }), {
  status: 403,
});

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

async function listFiles(name: string, prefix = '') {
  const { GET } = await import('./route');
  return GET(new NextRequest(`http://localhost/?prefix=${encodeURIComponent(prefix)}`), {
    params: Promise.resolve({ name }),
  });
}

async function download(name: string, key: string) {
  const { GET } = await import('./download/route');
  return GET(new NextRequest(`http://localhost/?key=${encodeURIComponent(key)}`), {
    params: Promise.resolve({ name }),
  });
}

describe('GET teams/[name]/files — SEC-03 读门控', () => {
  it('RBAC 拒绝（范围外 team）→ 403，且不发 MinIO 请求', async () => {
    rbacMock.mockResolvedValueOnce(denied);
    const res = await listFiles('other-team');
    expect(res.status).toBe(403);
    expect(listObjects).not.toHaveBeenCalled();
  });

  it('RBAC 放行 + 普通条目 → 200 正常列出', async () => {
    rbacMock.mockResolvedValueOnce(null);
    listObjects.mockImplementation(() =>
      makeListStream([
        { prefix: 'teams/t1/shared/' },
        { name: 'teams/t1/shared/README.md', size: 5 },
      ]),
    );
    const res = await listFiles('t1');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.objects).toHaveLength(2);
  });

  it('敏感条目（credentials.yaml / .ssh/）过滤后不进列表', async () => {
    rbacMock.mockResolvedValueOnce(null);
    listObjects.mockImplementation(() =>
      makeListStream([
        { name: 'teams/t1/shared/README.md', size: 5 },
        { name: 'teams/t1/shared/credentials.yaml', size: 9 },
        { name: 'teams/t1/.ssh/id_rsa', size: 3 },
      ]),
    );
    const res = await listFiles('t1');
    const json = await res.json();
    expect(json.objects).toHaveLength(1);
    expect(json.objects[0].key).toBe('teams/t1/shared/README.md');
    expect(JSON.stringify(json)).not.toContain('credentials.yaml');
    expect(JSON.stringify(json)).not.toContain('id_rsa');
  });
});

describe('GET teams/[name]/files/download — SEC-03 双门', () => {
  it('RBAC 拒绝 → 403，且不发 MinIO 请求', async () => {
    rbacMock.mockResolvedValueOnce(denied);
    const res = await download('other-team', 'teams/other-team/shared/README.md');
    expect(res.status).toBe(403);
    expect(statObject).not.toHaveBeenCalled();
  });

  it('RBAC 放行 + 敏感文件（credentials.yaml）→ 404 不暴露存在性', async () => {
    rbacMock.mockResolvedValueOnce(null);
    const res = await download('t1', 'teams/t1/shared/credentials.yaml');
    expect(res.status).toBe(404);
    expect(statObject).not.toHaveBeenCalled();
  });

  it('RBAC 放行 + 嵌套敏感目录（.ssh/id_rsa）→ 404', async () => {
    rbacMock.mockResolvedValueOnce(null);
    const res = await download('t1', 'teams/t1/home/.ssh/id_rsa');
    expect(res.status).toBe(404);
  });

  it('RBAC 放行 + 非敏感文件 → 正常下载', async () => {
    rbacMock.mockResolvedValueOnce(null);
    statObject.mockResolvedValue({ metaData: {}, size: 5 });
    getObject.mockResolvedValue(new Readable());
    const res = await download('t1', 'teams/t1/shared/README.md');
    expect(res.status).toBe(200);
  });

  it('key 越界（前缀不属于该 team）→ 400', async () => {
    rbacMock.mockResolvedValueOnce(null);
    const res = await download('t1', 'teams/other-team/shared/README.md');
    expect(res.status).toBe(400);
  });
});
