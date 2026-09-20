import { NextRequest, NextResponse } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../../../proxy-helper';
import { enforceServerSideRbac } from '@/lib/server-auth';
import { isValidNameSegment } from '@/lib/skill-package';

// B6 PATCH 单工具（上游 #1255）：声明式、可重试——
// - body = { enabled?: boolean, asyncExecution?: boolean }，至少一个；
//   未知字段 → 上游 400（两个可写字段就是全部面，fail-closed）
// - 本层只做前置校验（worker 名 + 工具名字符集，与上游 toolNamePattern 同值），
//   授权与语义以 Controller 为权威：
//   403（L2 跨团队写 / 团队 Leader 只读）/ 404（未知 worker·工具，W8 防探测）/
//   400（非 qwenpaw 运行时 / body 非法）/ 502 / 503 全部原样透传
// - 审计由 proxyToAgentTeams 统一挂接（PATCH ∈ AUDITED_METHODS，entity=worker）

const TOOL_NAME_RE = /^[A-Za-z0-9_]+$/;

const pathFor = (name: string, tool: string) =>
  `/api/v1/workers/${encodeURIComponent(name)}/tools/${encodeURIComponent(tool)}`;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string; tool: string }> },
) {
  const { name, tool } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  if (!tool || !TOOL_NAME_RE.test(tool)) {
    return NextResponse.json({ error: '非法工具名' }, { status: 400 });
  }
  const denied = await enforceServerSideRbac(request, 'update', 'worker', name);
  if (denied) return denied;
  const controllerUrl = getControllerUrl(request);
  return proxyToAgentTeams(request, controllerUrl, pathFor(name, tool), {
    forwardBody: true,
    method: 'PATCH',
  });
}
