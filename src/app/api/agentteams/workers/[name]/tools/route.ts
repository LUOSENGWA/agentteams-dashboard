import { NextRequest, NextResponse } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../../proxy-helper';
import { isValidNameSegment } from '@/lib/skill-package';

// B6 worker 内置工具设置（上游 #1255 已合并 main；issue #1254）：
// GET 透传，状态码原样回传（proxy-helper 既有语义）——
// - 响应 = { tools: [{name, enabled, description, asyncExecution, icon, requiresConfig}], total }
// - 工具配置值（config_fields/config_values）在上游代理边界即被剔除，本层只见状态
// - 旧 Controller 版本（未含 #1255）→ 404 透传 → 前端占位横幅（中性文案，不裸露上游 PR 号）
// - 400（非 qwenpaw 运行时）/ 502（worker-local API 不可用）/ 503（非 embedded）透传 → 前端错误横幅
// - 404（未知 worker / L2 跨团队 W8 防探测隐藏）透传 → 前端占位横幅
// - 审计由 proxyToAgentTeams 统一挂接（GET 非 mutation，不入审计）

const pathFor = (name: string) => `/api/v1/workers/${encodeURIComponent(name)}/tools`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  const controllerUrl = getControllerUrl(request);
  return proxyToAgentTeams(request, controllerUrl, pathFor(name), {
    forwardBody: false,
    method: 'GET',
  });
}
