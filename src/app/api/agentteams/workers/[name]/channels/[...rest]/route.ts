import { NextRequest, NextResponse } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../../../proxy-helper';
import { enforceServerSideRbac } from '@/lib/server-auth';
import { isValidNameSegment } from '@/lib/skill-package';

// B4 worker 频道矩阵（#1219 消费，契约=方案与设计/AgentTeams/PR/1219-worker-channels-api/pr-body.md，
// 9/14 定稿：9 端点；conflict-check（2.2.x-only 路由）当时移出，9/16 加回
// （上游 #1269 conflict-check 代理已合入 + 生产 runtime 在 2.2.x 线）→ 第 10 端点。
// 纪律（与上游同）：仅固定路径白名单转发，禁通用反代。
//   - 上游 404 双语义：#1219 未合并 / qwenpaw 构建无 channel router（版本门）→ 前端占位横幅
//   - PUT 读回校验头 X-AgentTeams-MinIO-Persisted（true/false/skipped）透传给前端展示
//   - qrcode/status 查询白名单（仅 token）由 Controller 强制；此处原样转发查询串
//   - PUT 空 body 拨号前 400 / kube 503 / Leader 写 403 / 跨团队 404 均由 Controller 强制
// 契约形状正源=QwenPaw console（SC/QwenPaw/console/src/api/modules/channel.ts + types/channel.ts）。

interface Endpoint {
  method: 'GET' | 'PUT' | 'POST';
  forwardBody: boolean;
  mutates: boolean;
}

// 白名单：rest 段 → 端点。其余组合一律 400。
function resolveEndpoint(rest: string[]): Endpoint | null {
  if (rest.length === 0) return { method: 'GET', forwardBody: false, mutates: false };
  if (rest[0] === 'types') return rest.length === 1 ? { method: 'GET', forwardBody: false, mutates: false } : null;
  if (rest[0] === 'schemas') return rest.length === 1 ? { method: 'GET', forwardBody: false, mutates: false } : null;
  if (rest.length === 1) {
    return { method: 'GET', forwardBody: false, mutates: false }; // 单频道配置（PUT 另行处理）
  }
  if (rest.length === 2) {
    if (rest[1] === 'health') return { method: 'GET', forwardBody: false, mutates: false };
    if (rest[1] === 'qrcode') return { method: 'GET', forwardBody: false, mutates: false };
    if (rest[1] === 'restart') return { method: 'POST', forwardBody: true, mutates: true };
    if (rest[1] === 'conflict-check') return { method: 'POST', forwardBody: true, mutates: true };
    return null;
  }
  if (rest.length === 3 && rest[1] === 'qrcode' && rest[2] === 'status') {
    return { method: 'GET', forwardBody: false, mutates: false };
  }
  return null;
}

const seg = (s: string) => encodeURIComponent(s);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string; rest: string[] }> },
) {
  const { name, rest = [] } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  for (const s of rest) {
    // types/schemas 与 ch 之外的段名也须通过字符合入（禁路径穿越/非法字符）
    if (!isValidNameSegment(s)) {
      return NextResponse.json({ error: '非法路径段' }, { status: 400 });
    }
  }
  const ep = resolveEndpoint(rest);
  if (!ep || ep.method !== 'GET') {
    return NextResponse.json({ error: '不支持的端点' }, { status: 400 });
  }
  const qs = request.nextUrl.search;
  const path = `/api/v1/workers/${seg(name)}/channels${rest.length ? '/' + rest.map(seg).join('/') : ''}${qs}`;
  const controllerUrl = getControllerUrl(request);
  return proxyToAgentTeams(request, controllerUrl, path, {
    forwardBody: false,
    method: 'GET',
    passthroughHeaders: ['x-agentteams-minio-persisted'],
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string; rest: string[] }> },
) {
  const { name, rest = [] } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  if (rest.length !== 1 || !isValidNameSegment(rest[0])) {
    return NextResponse.json({ error: '不支持的端点' }, { status: 400 });
  }
  const denied = await enforceServerSideRbac(request, 'update', 'worker', name);
  if (denied) return denied;
  const path = `/api/v1/workers/${seg(name)}/channels/${seg(rest[0])}`;
  const controllerUrl = getControllerUrl(request);
  return proxyToAgentTeams(request, controllerUrl, path, {
    forwardBody: true,
    method: 'PUT',
    passthroughHeaders: ['x-agentteams-minio-persisted'],
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string; rest: string[] }> },
) {
  const { name, rest = [] } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  if (rest.length !== 2 || !isValidNameSegment(rest[0]) || !isValidNameSegment(rest[1])) {
    return NextResponse.json({ error: '非法路径段' }, { status: 400 });
  }
  const ep = resolveEndpoint(rest);
  if (!ep || ep.method !== 'POST') {
    return NextResponse.json({ error: '不支持的端点' }, { status: 400 });
  }
  const denied = await enforceServerSideRbac(request, 'update', 'worker', name);
  if (denied) return denied;
  const path = `/api/v1/workers/${seg(name)}/channels/${seg(rest[0])}/${seg(rest[1])}`;
  const controllerUrl = getControllerUrl(request);
  return proxyToAgentTeams(request, controllerUrl, path, {
    forwardBody: true,
    method: 'POST',
    passthroughHeaders: ['x-agentteams-minio-persisted'],
  });
}
