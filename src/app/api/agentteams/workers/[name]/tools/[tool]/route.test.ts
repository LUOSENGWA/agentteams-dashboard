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

import { PATCH } from './route';

function callPATCH(name: string, tool: string, body?: string) {
  const req = new NextRequest(
    `http://localhost/api/agentteams/workers/${encodeURIComponent(name)}/tools/${encodeURIComponent(tool)}`,
    { method: 'PATCH', body, headers: { 'content-type': 'application/json' } },
  );
  return PATCH(req, { params: Promise.resolve({ name, tool }) });
}

describe('B6 /workers/[name]/tools/[tool] PATCH（#1255 消费）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceServerSideRbac.mockResolvedValue(null);
  });

  it('非法 Worker 名 → 400，不透传', async () => {
    const res = await callPATCH('bad/name', 'execute_shell_command', '{"enabled":false}');
    expect(res.status).toBe(400);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('非法工具名（含 / 或 - 点等）→ 400，不透传', async () => {
    for (const bad of ['bad/name', 'bad-name', 'bad.name', '']) {
      const res = await callPATCH('worker-1', bad, '{"enabled":false}');
      expect(res.status).toBe(400);
    }
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('RBAC 拒绝 → 直接返回，不透传', async () => {
    const denied = NextResponse.json({ error: 'forbidden' }, { status: 403 });
    enforceServerSideRbac.mockResolvedValue(denied);
    const res = await callPATCH('worker-1', 'execute_shell_command', '{"enabled":false}');
    expect(res.status).toBe(403);
    expect(proxyToAgentTeams).not.toHaveBeenCalled();
  });

  it('声明式 body 原样透传（forwardBody=true，method=PATCH，路径含编码工具名）', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ name: 'execute_shell_command', enabled: false }),
    );
    const res = await callPATCH('worker-1', 'execute_shell_command', '{"enabled":false}');
    expect(res.status).toBe(200);
    expect(proxyToAgentTeams).toHaveBeenCalledWith(
      expect.any(NextRequest),
      'http://agentteams-controller:8090',
      '/api/v1/workers/worker-1/tools/execute_shell_command',
      { forwardBody: true, method: 'PATCH' },
    );
  });

  it('双字段 body（enabled + asyncExecution）透传', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ name: 't1', enabled: true, asyncExecution: true }),
    );
    const res = await callPATCH('worker-1', 't1', '{"enabled":true,"asyncExecution":true}');
    expect(res.status).toBe(200);
  });

  it('403（Leader 只读 / L2 跨团队写）原样透传 → 前端转只读', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'read only' }, { status: 403 }),
    );
    expect((await callPATCH('worker-1', 't1', '{"enabled":false}')).status).toBe(403);
  });

  it('404（未知 worker / 未知工具，W8 防探测）/ 400（body 非法）/ 502 原样透传', async () => {
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'not found' }, { status: 404 }),
    );
    expect((await callPATCH('worker-1', 'nope', '{"enabled":false}')).status).toBe(404);
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'unknown field' }, { status: 400 }),
    );
    expect((await callPATCH('worker-1', 't1', '{"x":1}')).status).toBe(400);
    proxyToAgentTeams.mockResolvedValue(
      NextResponse.json({ error: 'tools API unavailable' }, { status: 502 }),
    );
    expect((await callPATCH('worker-1', 't1', '{"enabled":false}')).status).toBe(502);
  });
});
