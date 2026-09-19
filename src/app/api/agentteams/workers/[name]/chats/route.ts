import { NextRequest, NextResponse } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../../proxy-helper';
import { isValidNameSegment } from '@/lib/skill-package';

// C worker 会话只读列表（上游 #1295，等合并；issue #1293）：
// GET 透传，状态码原样回传（proxy-helper 既有语义）——
// - 响应 = list[ChatSpec]：{id, name, session_id, user_id, channel,
//   created_at, updated_at, pinned, archived, source, metadata}
// - query 白名单（user_id/channel/archived/include_app_owned）与未知参数 400
//   由上游强制（本层薄透传，不重复实现白名单）
// - L2 服务端强制 room 级参与边界（caller token → joined_rooms），
//   前端不做过滤——过滤≠鉴权
// - 404 = 未知 worker / L2 不在该 worker 团队（W8 不可探测）/ 旧 Controller
//   → 前端占位横幅；400 / 502（worker 不可达）/ 503（非 embedded）透传
// - 只读端点，无审计（checkpoints/channels-GET 一致先例）

const pathFor = (name: string, search: string) =>
  `/api/v1/workers/${encodeURIComponent(name)}/chats${search}`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  const controllerUrl = getControllerUrl(request);
  return proxyToAgentTeams(request, controllerUrl, pathFor(name, request.nextUrl.search), {
    forwardBody: false,
    method: 'GET',
  });
}
