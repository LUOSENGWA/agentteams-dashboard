import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const proxyToAgentTeams = vi.fn();
const getControllerUrl = vi.fn((..._a: unknown[]) => 'http://agentteams-controller:8090');

vi.mock('../../../../proxy-helper', () => ({
  proxyToAgentTeams: (...a: unknown[]) => proxyToAgentTeams(...a),
  getControllerUrl: (...a: unknown[]) => getControllerUrl(...a),
}));

import { GET } from './route';

const C = 'http://agentteams-controller:8090';

function call(sub: string, query = '', name = 'w1') {
  const url = `http://localhost/api/agentteams/workers/${encodeURIComponent(name)}/workspace-files/${sub}${query}`;
  return GET(new NextRequest(url, { method: 'GET' }), {
    params: Promise.resolve({ name, sub }),
  });
}

describe('B7 /workers/[name]/workspace-files/[sub]（#1208 只读三子路径）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['tree', '/api/v1/workers/w1/workspace-files/tree'],
    ['file-metadata', '/api/v1/workers/w1/workspace-files/file-metadata'],
    ['file-content', '/api/v1/workers/w1/workspace-files/file-content'],
  ])('GET %s → %s 透传', async (sub, path) => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({}));
    await call(sub, '?path=memory');
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest), C, `${path}?path=memory`,
      { forwardBody: false, method: 'GET' },
    );
  });

  it('查询串原样透传（path/cursor/offset/limit 白名单由 Controller D7 强制）', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({}));
    await call('file-content', '?path=memory%2F2026-09-14%2Fa.md&offset=100&limit=200000');
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest), C,
      '/api/v1/workers/w1/workspace-files/file-content?path=memory%2F2026-09-14%2Fa.md&offset=100&limit=200000',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it.each([
    ['file-upload（写端点永不可达）'],
    ['download'],
    ['restore'],
    ['graph（不在 #1208 终稿白名单）'],
  ])('白名单拒绝：%s → 400 零透传', async (sub) => {
    const res = await call(sub.split('（')[0]);
    expect(res.status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('非法 Worker 名 → 400 零透传', async () => {
    const res = await call('tree', '', 'bad/name');
    expect(res.status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('上游 404（#1208 未合并）原样透传 → 前端占位横幅', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({ detail: 'not found' }, { status: 404 }));
    const res = await call('tree', '?path=memory');
    expect(res.status).toBe(404);
  });
});
