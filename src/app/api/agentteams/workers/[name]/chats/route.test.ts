import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const proxyToAgentTeams = vi.fn();
const getControllerUrl = vi.fn((..._a: unknown[]) => 'http://agentteams-controller:8090');

vi.mock('../../../proxy-helper', () => ({
  proxyToAgentTeams: (...a: unknown[]) => proxyToAgentTeams(...a),
  getControllerUrl: (...a: unknown[]) => getControllerUrl(...a),
}));

import { GET } from './route';

function callGET(name: string, search = '') {
  const req = new NextRequest(
    `http://localhost/api/agentteams/workers/${encodeURIComponent(name)}/chats${search}`,
    { method: 'GET' },
  );
  return GET(req, { params: Promise.resolve({ name }) });
}

describe('C /workers/[name]/chats GET（#1295 消费）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('非法 Worker 名 → 400，不透传', async () => {
    const res = await callGET('bad/name');
    expect(res.status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('透传到 /api/v1/workers/{name}/chats（forwardBody=false）', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json([
        {
          id: 'c1',
          name: 'matrix:!room1:matrix.local',
          session_id: 'matrix:!room1:matrix.local',
          user_id: '@luo:matrix.local',
          channel: 'matrix',
          updated_at: '2026-09-19T10:00:00Z',
        },
      ]),
    );
    const res = await callGET('worker-1');
    expect(res.status).toBe(200);
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest),
      'http://agentteams-controller:8090',
      '/api/v1/workers/worker-1/chats',
      { forwardBody: false, method: 'GET' },
    );
  });

  it('query 白名单参数原样透传（过滤语义由上游强制）', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json([]));
    await callGET('worker-1', '?channel=matrix&archived=true');
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest),
      'http://agentteams-controller:8090',
      '/api/v1/workers/worker-1/chats?channel=matrix&archived=true',
      { forwardBody: false, method: 'GET' },
    );
  });

  it('404（未知 worker / L2 边界外 / 旧 Controller）原样透传 → 前端占位', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'not found' }, { status: 404 }),
    );
    expect((await callGET('worker-1')).status).toBe(404);
  });

  it('400（未知 query 参数，上游白名单）/ 502 / 503 原样透传', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'unknown parameter' }, { status: 400 }),
    );
    expect((await callGET('worker-1', '?bogus=1')).status).toBe(400);
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'worker unreachable' }, { status: 502 }),
    );
    expect((await callGET('worker-1')).status).toBe(502);
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'not embedded' }, { status: 503 }),
    );
    expect((await callGET('worker-1')).status).toBe(503);
  });
});
