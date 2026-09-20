import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const proxyToAgentTeams = vi.fn();
const getControllerUrl = vi.fn((..._a: unknown[]) => 'http://agentteams-controller:8090');

vi.mock('../../../../proxy-helper', () => ({
  proxyToAgentTeams: (...a: unknown[]) => proxyToAgentTeams(...a),
  getControllerUrl: (...a: unknown[]) => getControllerUrl(...a),
}));

import { GET } from './route';

function callGET(name: string, chatId: string, search = '') {
  const req = new NextRequest(
    `http://localhost/api/agentteams/workers/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}${search}`,
    { method: 'GET' },
  );
  return GET(req, { params: Promise.resolve({ name, chatId }) });
}

describe('C /workers/[name]/chats/[chatId] GET（agent 上下文，#1295 消费）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('非法 Worker 名 → 400', async () => {
    expect((await callGET('bad/name', 'c1')).status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('非法 chat_id（大写 / 点 / 连字符首尾 / 空 / 路径注入）→ 400，不透传', async () => {
    for (const bad of ['C1', 'a.b', '-c1', 'c1-', '', '..', 'a/b']) {
      expect((await callGET('worker-1', bad)).status).toBe(400);
    }
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('uuid4 形态 chat_id 合法 → 透传（路径含编码）', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({
        messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
        status: 'idle',
      }),
    );
    const id = '3f0e6a32-9b1c-4d5e-8f2a-1c2d3e4f5a6b';
    const res = await callGET('worker-1', id);
    expect(res.status).toBe(200);
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest),
      'http://agentteams-controller:8090',
      `/api/v1/workers/worker-1/chats/${id}`,
      { forwardBody: false, method: 'GET' },
    );
  });

  it('任何 query 不透传（detail 端点上游禁止 query → fail-closed 不带 search）', async () => {
    proxyToAgentTeams.mockResolvedValue(NextResponse.json({ messages: [], status: 'idle' }));
    await callGET('worker-1', 'c1', '?bogus=1');
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest),
      'http://agentteams-controller:8090',
      '/api/v1/workers/worker-1/chats/c1',
      { forwardBody: false, method: 'GET' },
    );
  });

  it('404（未知 chat / L2 房间边界外 / 旧 Controller）/ 400 / 502 原样透传', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ detail: 'Chat not found: c1' }, { status: 404 }),
    );
    expect((await callGET('worker-1', 'c1')).status).toBe(404);
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'bad' }, { status: 400 }),
    );
    expect((await callGET('worker-1', 'c1')).status).toBe(400);
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'worker unreachable' }, { status: 502 }),
    );
    expect((await callGET('worker-1', 'c1')).status).toBe(502);
  });
});
