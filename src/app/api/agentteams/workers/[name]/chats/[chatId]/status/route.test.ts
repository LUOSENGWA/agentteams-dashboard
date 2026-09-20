import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const proxyToAgentTeams = vi.fn();
const getControllerUrl = vi.fn((..._a: unknown[]) => 'http://agentteams-controller:8090');

vi.mock('../../../../../proxy-helper', () => ({
  proxyToAgentTeams: (...a: unknown[]) => proxyToAgentTeams(...a),
  getControllerUrl: (...a: unknown[]) => getControllerUrl(...a),
}));

import { GET } from './route';

function callGET(name: string, chatId: string) {
  const req = new NextRequest(
    `http://localhost/api/agentteams/workers/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/status`,
    { method: 'GET' },
  );
  return GET(req, { params: Promise.resolve({ name, chatId }) });
}

describe('C /workers/[name]/chats/[chatId]/status GET（#1295 消费）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('非法 Worker 名 / chat_id → 400，不透传', async () => {
    expect((await callGET('bad/name', 'c1')).status).toBe(400);
    expect((await callGET('worker-1', 'C1')).status).toBe(400);
    expect((await callGET('worker-1', '')).status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('透传到 .../chats/{id}/status', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({ status: 'running' }));
    const res = await callGET('worker-1', 'c1');
    expect(res.status).toBe(200);
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest),
      'http://agentteams-controller:8090',
      '/api/v1/workers/worker-1/chats/c1/status',
      { forwardBody: false, method: 'GET' },
    );
  });

  it('旧 runtime（<2.2.1）无 /status → 上游 404 原样透传（前端隐藏状态灯）', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ detail: 'Not Found' }, { status: 404 }),
    );
    expect((await callGET('worker-1', 'c1')).status).toBe(404);
  });

  it('worker 不可达 502 / 非 embedded 503 原样透传', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'worker unreachable' }, { status: 502 }),
    );
    expect((await callGET('worker-1', 'c1')).status).toBe(502);
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'not embedded' }, { status: 503 }),
    );
    expect((await callGET('worker-1', 'c1')).status).toBe(503);
  });
});
