import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const proxyToAgentTeams = vi.fn();
const getControllerUrl = vi.fn((..._a: unknown[]) => 'http://agentteams-controller:8090');
const enforceServerSideRbac = vi.fn();

vi.mock('../../../../proxy-helper', () => ({
  proxyToAgentTeams: (...a: unknown[]) => proxyToAgentTeams(...a),
  getControllerUrl: (...a: unknown[]) => getControllerUrl(...a),
}));
vi.mock('@/lib/server-auth', () => ({
  enforceServerSideRbac: (...a: unknown[]) => enforceServerSideRbac(...a),
}));

import { GET, PUT, POST } from './route';

function req(method: 'GET' | 'PUT' | 'POST', name: string, rest: string[], query = '', body?: string) {
  const url = `http://localhost/api/agentteams/workers/${encodeURIComponent(name)}/channels${rest.length ? '/' + rest.join('/') : ''}${query}`;
  const init: { method: string; body?: string; headers?: Record<string, string> } = { method };
  if (body !== undefined) {
    init.body = body;
    init.headers = { 'content-type': 'application/json' };
  }
  return new NextRequest(url, init);
}

function call(handler: (_r: NextRequest, _p: { params: Promise<{ name: string; rest: string[] }> }) => Promise<NextResponse>, method: 'GET' | 'PUT' | 'POST', name: string, rest: string[], query = '', body?: string) {
  return handler(req(method, name, rest, query, body), { params: Promise.resolve({ name, rest }) });
}

const C = 'http://agentteams-controller:8090';

describe('B4 /workers/[name]/channels/[...rest]（#1219 九端点白名单）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceServerSideRbac.mockResolvedValue(null);
  });

  it('GET 列表：/api/v1/workers/w1/channels，forwardBody=false', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({ qq: {} }));
    await call(GET, 'GET', 'w1', []);
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest), C,
      '/api/v1/workers/w1/channels',
      { forwardBody: false, method: 'GET', passthroughHeaders: ['x-agentteams-minio-persisted'] },
    );
  });

  it.each([
    ['types', '/api/v1/workers/w1/channels/types'],
    ['schemas', '/api/v1/workers/w1/channels/schemas'],
    ['qq', '/api/v1/workers/w1/channels/qq'],
    ['qq|health', '/api/v1/workers/w1/channels/qq/health'],
    ['qq|qrcode', '/api/v1/workers/w1/channels/qq/qrcode'],
  ])('GET %s → %s', async (rest, path) => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({}));
    await call(GET, 'GET', 'w1', rest.split('|'));
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest), C, path,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('GET qrcode/status：token 查询串原样转发', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({ status: 'waiting' }));
    await call(GET, 'GET', 'w1', ['qq', 'qrcode', 'status'], '?token=abc%3D');
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest), C,
      '/api/v1/workers/w1/channels/qq/qrcode/status?token=abc%3D',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('PUT 单频道：RBAC + forwardBody + minio-persisted 透传头', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({}));
    await call(PUT, 'PUT', 'w1', ['qq'], '', '{"enabled":true}');
    expect(enforceServerSideRbac).toHaveBeenCalledWith(expect.any(NextRequest), 'update', 'worker', 'w1');
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest), C,
      '/api/v1/workers/w1/channels/qq',
      { forwardBody: true, method: 'PUT', passthroughHeaders: ['x-agentteams-minio-persisted'] },
    );
  });

  it('PUT 被 RBAC 拒绝 → 不透传', async () => {
    const denied = NextResponse.json({ error: 'forbidden' }, { status: 403 });
    enforceServerSideRbac.mockResolvedValue(denied);
    const res = await call(PUT, 'PUT', 'w1', ['qq'], '', '{"enabled":true}');
    expect(res.status).toBe(403);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('POST restart：method=POST + RBAC', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({ status: 'restarted' }));
    await call(POST, 'POST', 'w1', ['qq', 'restart']);
    expect(enforceServerSideRbac).toHaveBeenCalled();
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest), C,
      '/api/v1/workers/w1/channels/qq/restart',
      { forwardBody: true, method: 'POST', passthroughHeaders: ['x-agentteams-minio-persisted'] },
    );
  });

  it.each([
    ['conflict-check 已移出契约（2.2.x follow-up）', ['qq', 'conflict-check']],
    ['未知子路径', ['qq', 'bogus']],
    ['超长段', ['qq', 'qrcode', 'status', 'x']],
  ])('白名单拒绝：%s → 400 零透传', async (_label, rest) => {
    const res = await call(GET, 'GET', 'w1', rest);
    expect(res.status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('PUT 非单频道路径 → 400', async () => {
    const res = await call(PUT, 'PUT', 'w1', ['qq', 'health'], '', '{}');
    expect(res.status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('非法 Worker 名 → 400 零透传', async () => {
    const res = await call(GET, 'GET', 'bad/name', []);
    expect(res.status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('上游 404（#1219 未合并/版本门）原样透传 → 前端占位横幅', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({ detail: 'not found' }, { status: 404 }));
    const res = await call(GET, 'GET', 'w1', []);
    expect(res.status).toBe(404);
  });
});
