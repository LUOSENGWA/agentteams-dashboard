import { NextRequest, NextResponse } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../../../proxy-helper';
import { isValidNameSegment } from '@/lib/skill-package';

// B7 知识库（#1208 workspace-files 消费，只读）。契约=方案与设计/AgentTeams/PR/
// 1208-worker-workspace-files/worker-workspace-files-方案.md（终稿 D1-D8）：
//   GET /api/v1/workers/{name}/workspace-files/{sub}
//   sub ∈ { tree, file-metadata, file-content }（写端点永不可达——Controller 白名单）
// 上游（QwenPaw workspace.py）响应形状：
//   tree         → { directory, entries: [{kind,name,path,size,modified_at,preview_kind}], has_more, next_cursor }
//   file-metadata→ { etag, modified_at, path, preview_kind, size }
//   file-content → { content, encoding, eof, etag, limit, next_offset, offset }（offset/limit 分块读）
// Controller 生死线（D3）：path="" 禁（无根列表）；白名单=MEMORY.md+memory/**+digest/**；
// root=workspace 服务端固定（dashboard 不得传 root）。
// 降级：#1208 未合并 → 上游 404 → 前端占位横幅。

const SUB_WHITELIST: ReadonlySet<string> = new Set(['tree', 'file-metadata', 'file-content']);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string; sub: string }> },
) {
  const { name, sub } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  if (!SUB_WHITELIST.has(sub)) {
    return NextResponse.json({ error: `不支持的子路径：${sub}` }, { status: 400 });
  }
  // 查询串原样透传（path/cursor/offset/limit 白名单由 Controller D7 强制——
  // 未知参数 400；dashboard 不重复校验，保持 L1 纯透传语义）
  const qs = request.nextUrl.search;
  const path = `/api/v1/workers/${encodeURIComponent(name)}/workspace-files/${sub}${qs}`;
  const controllerUrl = getControllerUrl(request);
  return proxyToAgentTeams(request, controllerUrl, path, {
    forwardBody: false,
    method: 'GET',
  });
}
