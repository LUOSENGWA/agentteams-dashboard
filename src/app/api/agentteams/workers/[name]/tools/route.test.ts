import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const proxyToAgentTeams = vi.fn();
const getControllerUrl = vi.fn((..._a: unknown[]) => 'http://agentteams-controller:8090');

vi.mock('../../../proxy-helper', () => ({
  proxyToAgentTeams: (...a: unknown[]) => proxyToAgentTeams(...a),
  getControllerUrl: (...a: unknown[]) => getControllerUrl(...a),
}));

import { GET } from './route';

function callGET(name: string) {
  const req = new NextRequest(
    `http://localhost/api/agentteams/workers/${encodeURIComponent(name)}/tools`,
    { method: 'GET' },
  );
  return GET(req, { params: Promise.resolve({ name }) });
}

describe('B6 /workers/[name]/tools GET（#1255 消费）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('非法 Worker 名 → 400，不透传', async () => {
    const res = await callGET('bad/name');
    expect(res.status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('透传到 /api/v1/workers/{name}/tools（forwardBody=false）', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({
        tools: [
          {
            name: 'execute_shell_command',
            enabled: true,
            description: 'Execute a shell command',
            asyncExecution: false,
            icon: '🔧',
            requiresConfig: false,
          },
        ],
        total: 1,
      }),
    );
    const res = await callGET('worker-1');
    expect(res.status).toBe(200);
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest),
      'http://agentteams-controller:8090',
      '/api/v1/workers/worker-1/tools',
      { forwardBody: false, method: 'GET' },
    );
  });

  it('404（旧 Controller / L2 跨团队隐藏）原样透传 → 前端占位横幅', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'not found' }, { status: 404 }),
    );
    const res = await callGET('worker-1');
    expect(res.status).toBe(404);
  });

  it('400（非 qwenpaw 运行时）原样透传 → 前端错误横幅', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'unsupported runtime' }, { status: 400 }),
    );
    const res = await callGET('worker-1');
    expect(res.status).toBe(400);
  });

  it('502（worker-local API 不可用）/ 503（非 embedded）原样透传', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'tools API unavailable' }, { status: 502 }),
    );
    expect((await callGET('worker-1')).status).toBe(502);
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'not embedded' }, { status: 503 }),
    );
    expect((await callGET('worker-1')).status).toBe(503);
  });
});
