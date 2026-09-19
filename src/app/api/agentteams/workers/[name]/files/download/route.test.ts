import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const { statObject, getObject } = vi.hoisted(() => ({
  statObject: vi.fn(),
  getObject: vi.fn(),
}));

vi.mock('@/lib/minio-client', () => ({
  createMinioClient: () => ({ statObject, getObject }),
  getMinioBucket: () => 'agentteams-storage',
}));

const rbacMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server-auth', () => ({
  enforceServerSideRbac: (...args: unknown[]) => rbacMock(...args),
}));

const denied = new NextResponse(JSON.stringify({ success: false, error: 'rbac.deny' }), {
  status: 403,
});

async function download(name: string, key: string) {
  return GET(new NextRequest(`http://localhost/?key=${encodeURIComponent(key)}`), {
    params: Promise.resolve({ name }),
  });
}

describe('GET files/download — B1 权限边界（维护者 1.2.4 联调验收报告）', () => {
  it('范围外 Worker（RBAC 拒绝）→ 403，且不发 MinIO 请求', async () => {
    rbacMock.mockResolvedValueOnce(denied);
    const res = await download('accept0919', 'accept0919/.qwenpaw/workspaces/default/credentials.yaml');
    expect(res.status).toBe(403);
    expect(statObject).not.toHaveBeenCalled();
  });

  it('RBAC 放行时敏感文件（credentials.yaml 独立文件）→ 404 不暴露存在性', async () => {
    rbacMock.mockResolvedValueOnce(null);
    const res = await download('w1', 'w1/credentials.yaml');
    expect(res.status).toBe(404);
    expect(statObject).not.toHaveBeenCalled();
  });

  it('敏感文件在子目录（rel 判定）→ 404', async () => {
    rbacMock.mockResolvedValueOnce(null);
    const res = await download('w1', 'w1/secrets/credentials.yaml');
    expect(res.status).toBe(404);
  });

  it('RBAC 放行 + 非敏感文件 → 正常下载', async () => {
    rbacMock.mockResolvedValueOnce(null);
    statObject.mockResolvedValue({ metaData: {}, size: 6 });
    getObject.mockResolvedValue(new Readable());
    const res = await download('w1', 'w1/MEMORY.md');
    expect(res.status).toBe(200);
  });
});
