import { NextRequest, NextResponse } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../../../../proxy-helper';
import { isValidNameSegment } from '@/lib/skill-package';

// C worker 会话状态——上游 #1295，issue #1293。
// - 响应 = {status: "idle"|"running"}，恒 200（只查 task_tracker，
//   chat 不存在也返回 idle）
// - 版本门：/status 路由仅 QwenPaw ≥2.2.1 有——旧 runtime 返回 404
//   （FastAPI 默认 Not Found），前端据此隐藏状态灯（版本无关门，skills 先例）
// - chat_id 校验与上游同值；本层不透传 query
// - 只读端点，无审计

const CHAT_ID_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const pathFor = (name: string, chatId: string) =>
  `/api/v1/workers/${encodeURIComponent(name)}/chats/${encodeURIComponent(chatId)}/status`;

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
