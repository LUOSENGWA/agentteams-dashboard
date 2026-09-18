import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/dashboard-session';
import { getAuthToken, getControllerUrl, auditProxiedMutation } from '../../../proxy-helper';
import { appendAuditEvent } from '@/lib/audit-log';
import { readServerIdentity } from '@/lib/server-auth';
import { isValidNameSegment } from '@/lib/skill-package';
import {
  APPROVAL_LEVELS,
  ApprovalLevel,
  ApprovalPlaneError,
  readApprovalDocker,
  writeApprovalDocker,
} from '@/lib/approval-docker';

// Worker 工具执行安全（approval_level 四档）——双数据面，9/18 装验定案「照插件做」。
//
// 平面 1（L1，旧/新 Controller 均可用）：Controller Docker 代理
//   读 = archive 直读容器 agent.json（与 KB v2 同通道）
//   写 = exec 容器内 python GET→改 approval_level→整 PUT running-config
//        （live 热加载 + agent.json 落盘 + push_loop MinIO 同步；插件同款）
//   权限门：仅 L1 会话（credential kind 'sa' / 'controller-token'，dashboard
//   level 3）可走 Docker 平面——与 Controller RequireAuthz(ActionGateway) 的
//   L1-only 语义对齐。L2（kind 'matrix'）直跳 REST 平面，不用 SA token 代跑
//   Docker（防越权：BFF 侧先拦，不依赖 Controller 侧 403）。
// 平面 2（Controller >= #1216，L2 团队 scope）：
//   GET/PUT /api/v1/workers/{name}/approval
//   L2 本团队可读写（OFF→403）；team leader 只读（PUT 403）；跨团队 404(W8)。
//
// 路由顺序（读）：REST 优先（新版 Controller 走正规边界，含 Controller 审计）→
//   404 = 旧 Controller 或跨团队 scope → Docker 兜底（仅 L1）。
// 路由顺序（写）：L1 → Docker 优先（插件同款：不依赖 Controller 版本）；
//   L2 → 直接 REST。
//
// 状态语义（UI 契约）：
//   GET 200 {approval_level, source}        → 显示
//   GET 403 {error, l2_hint}                → 琥珀提示（L2 读不到，不报错）
//   GET 404 {error}                         → 整节隐藏（Worker 不存在/两平面均不可用）
//   PUT 200 {ok, level, verified, source}   → toast 成功（verified=null → 前端重读）
//   PUT 400 {error}                         → 非法档位（未触碰上游）
//   PUT 403 {error}                         → 无权限（L2 设 OFF / team leader）
//   PUT 404 {error}                         → 两平面均不可用（旧 Controller + L2）
//   PUT 409 {error}                         → 并发冲突，稍后重试

const L2_READ_HINT = 'L2 账号无权限读取（需 L1 管理员凭据；Controller 升级含 #1216 审批端点后自动开放）';

// 与 proxyToAgentTeams 同款 token 解析（proxy-helper L205-215）：会话 token
// 优先（L2 matrix / CR level 1 controller-token），无会话 token 回落 SA env
// token，最后才是浏览器头（仅 legacy dev 兜底）。
async function resolveRestToken(request: NextRequest): Promise<string | undefined> {
  const session = getSessionFromRequest(request);
  const sessionToken =
    session?.credential.kind === 'matrix' || session?.credential.kind === 'controller-token'
      ? session.credential.token
      : undefined;
  const saToken = await getAuthToken();
  return (
    sessionToken ||
    saToken ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    undefined
  );
}

// Docker 平面 token：L1 会话自己的凭据（'controller-token' 用自带 token，
// 'sa'/pre-login 用 env SA token）。L2 会话不进 Docker 平面（调用方已门控）。
async function resolveDockerToken(request: NextRequest): Promise<string | undefined> {
  const session = getSessionFromRequest(request);
  if (session?.credential.kind === 'controller-token') return session.credential.token;
  return getAuthToken();
}

function isL1Session(request: NextRequest): boolean {
  const session = getSessionFromRequest(request);
  return !session || session.credential.kind !== 'matrix';
}

function identityHeaders(request: NextRequest): Record<string, string> {
  // 转发服务端解析的身份头（middleware 写入），Controller 据此归属 L2 写操作。
  const out: Record<string, string> = {};
  for (const name of ['x-agentteams-user', 'x-agentteams-user-level']) {
    const value = request.headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

async function restApproval(
  request: NextRequest,
  controllerUrl: string,
  token: string | undefined,
  name: string,
  method: 'GET' | 'PUT',
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(
      `${controllerUrl.replace(/\/$/, '')}/api/v1/workers/${encodeURIComponent(name)}/approval`,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...identityHeaders(request),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (err) {
    return {
      status: 502,
      json: { error: `Controller 请求失败：${err instanceof Error ? err.message : String(err)}` },
    };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = { error: `Controller 响应非 JSON（${res.status}）` };
  }
  return { status: res.status, json };
}

function jsonFromError(e: unknown): NextResponse {
  if (e instanceof ApprovalPlaneError) {
    const payload: Record<string, unknown> = { error: e.message };
    if (e.status === 403) payload.l2_hint = L2_READ_HINT;
    return NextResponse.json(payload, { status: e.status });
  }
  return NextResponse.json(
    { error: e instanceof Error ? e.message : String(e) },
    { status: 500 },
  );
}

function auditDockerWrite(request: NextRequest, name: string, level: string, source: string): void {
  // Docker 平面写不经 proxyToAgentTeams → 这里补审计（同 proxy 钩子语义）。
  const identity = readServerIdentity(request);
  if (!identity) return;
  void appendAuditEvent({
    actor: identity.name,
    actor_level: identity.level,
    entity_type: 'worker',
    entity_name: name,
    action: 'approval',
    details: `PUT /api/agentteams/workers/${name}/approval (${source}) → ${level}`,
    severity: 'info',
    source_ip: identity.sourceIp,
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  const controllerUrl = getControllerUrl(request);
  const rest = await restApproval(request, controllerUrl, await resolveRestToken(request), name, 'GET');
  if (rest.status === 200 && typeof (rest.json as { approval_level?: unknown })?.approval_level === 'string') {
    return NextResponse.json({
      approval_level: (rest.json as { approval_level: string }).approval_level.toUpperCase(),
      source: 'controller',
    });
  }
  if (rest.status === 401 || rest.status === 403 || rest.status === 503) {
    // 鉴权/权限/模式问题：透传（L1 token 异常 / kube 模式 503 / leader 读不受影响）。
    return NextResponse.json(rest.json, { status: rest.status });
  }
  // 404（旧 Controller 或跨团队 W8）/其他 → Docker 兜底（仅 L1）。
  if (!isL1Session(request)) {
    // L2 + 旧 Controller（或跨团队）：无可用平面 → 403 琥珀提示（不暴露存在性）。
    return NextResponse.json({ error: L2_READ_HINT, l2_hint: L2_READ_HINT }, { status: 403 });
  }
  try {
    const level = await readApprovalDocker(controllerUrl, await resolveDockerToken(request), name);
    return NextResponse.json({ approval_level: level, source: 'docker-archive' });
  } catch (e) {
    return jsonFromError(e);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!isValidNameSegment(name)) {
    return NextResponse.json({ error: '非法 Worker 名' }, { status: 400 });
  }
  let body: { approval_level?: unknown };
  try {
    body = (await request.json()) as { approval_level?: unknown };
  } catch {
    return NextResponse.json({ error: '请求体需为 JSON' }, { status: 400 });
  }
  const raw = String(body.approval_level ?? '').trim().toUpperCase();
  if (!(APPROVAL_LEVELS as readonly string[]).includes(raw)) {
    return NextResponse.json(
      { error: `approval_level 必须是 ${APPROVAL_LEVELS.join(' / ')} 之一` },
      { status: 400 },
    );
  }
  const level = raw as ApprovalLevel;
  const controllerUrl = getControllerUrl(request);
  const l1 = isL1Session(request);

  // L1 → Docker 平面优先（插件同款：不依赖 Controller 版本；live 热加载）。
  if (l1) {
    try {
      const { verified } = await writeApprovalDocker(
        controllerUrl,
        await resolveDockerToken(request),
        name,
        level,
      );
      auditDockerWrite(request, name, level, 'docker-exec');
      return NextResponse.json({ ok: true, level, verified, source: 'docker-exec' });
    } catch (e) {
      if (e instanceof ApprovalPlaneError && (e.status === 401 || e.status === 403)) {
        // SA token 异常等：回落 REST 再试一次。
      } else {
        // 404（Worker 不存在）/502（exec 或 worker app 失败）→ 直接透传。
        return jsonFromError(e);
      }
    }
  }

  // REST 平面：L2 团队 scope / L1 Docker 异常兜底。
  const rest = await restApproval(
    request,
    controllerUrl,
    await resolveRestToken(request),
    name,
    'PUT',
    { approval_level: level },
  );
  auditProxiedMutation(request, `/api/v1/workers/${name}/approval`, 'PUT', rest.status);
  if (rest.status === 200) {
    // best-effort 回读验证（#1216：409 透传、全量往返）。
    let verified: string | null = null;
    try {
      const back = await restApproval(
        request,
        controllerUrl,
        await resolveRestToken(request),
        name,
        'GET',
      );
      if (back.status === 200 && typeof (back.json as { approval_level?: unknown })?.approval_level === 'string') {
        verified = (back.json as { approval_level: string }).approval_level.toUpperCase();
      }
    } catch {
      verified = null;
    }
    return NextResponse.json({ ok: true, level, verified, source: 'controller' });
  }
  const detail =
    typeof (rest.json as { detail?: unknown })?.detail === 'string'
      ? (rest.json as { detail: string }).detail
      : '';
  if (rest.status === 403) {
    return NextResponse.json(
      { error: detail || '无权限设置该级别（L2 不能设 OFF；team leader 只读）' },
      { status: 403 },
    );
  }
  if (rest.status === 404) {
    return NextResponse.json(
      { error: '审批端点不可用（Controller 未升级 #1216 且 L1 通道不可用）' },
      { status: 404 },
    );
  }
  if (rest.status === 409) {
    return NextResponse.json(
      { error: `Worker 更新中（并发冲突），请稍后重试${detail ? `：${detail}` : ''}` },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { error: detail || `设置失败（Controller ${rest.status}）` },
    { status: rest.status >= 400 && rest.status < 600 ? rest.status : 502 },
  );
}
