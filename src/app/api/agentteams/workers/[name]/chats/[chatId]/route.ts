import { NextRequest, NextResponse } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../../../proxy-helper';
import { isValidNameSegment } from '@/lib/skill-package';

// C worker 会话详情（agent 上下文，只读）——上游 #1295，issue #1293。
// - 响应 = ChatHistory{messages: list[Message], status}；Message 的 content
//   块可含工具调用/结果（前端必须标注「Agent 上下文」，区别于实发房间消息）
// - chat_id 字符集校验与上游 chatIDPattern 同值（uuid4 全匹配 + 挡路径注入）；
//   detail 端点上游禁止任何 query——本层不透传 search（fail-closed）
// - 404 = 未知 worker / 未知 chat / L2 房间边界外（W8 统一不可探测）/ 旧 Controller
// - 只读端点，无审计

const CHAT_ID_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const pathFor = (name: string, chatId: string) =>
  `/api/v1/workers/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string; chatId: string }> },
) {
  const { name, chatId } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  if (!chatId || !CHAT_ID_RE.test(chatId)) {
    return NextResponse.json({ error: '非法会话 ID' }, { status: 400 });
  }
  const controllerUrl = getControllerUrl(request);
  return proxyToAgentTeams(request, controllerUrl, pathFor(name, chatId), {
    forwardBody: false,
    method: 'GET',
  });
}
