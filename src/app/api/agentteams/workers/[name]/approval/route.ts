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
// 平面 1（REST，Controller >= #1216，主平面）：
//   GET/PUT /api/v1/workers/{name}/approval
//   L2 本团队可读写（OFF→403）；team leader 只读（PUT 403）；跨团队 404(W8)。
//   读写均走此平面优先（含 Controller 侧审计；评审修订：写路径也 REST 优先，
//   新 Controller 不再绕开 #1216 边界）。
// 平面 2（Docker，兜底；env flag AGENTTEAMS_APPROVAL_DOCKER_PLANE=1 才启用，
// 默认关——评审修订：exec 写入容器属高敏感通道，须显式开启）：
//   仅 L1 会话（credential kind 'sa' / 'controller-token'，dashboard level 3）
//   可走——与 Controller RequireAuthz(ActionGateway) 的 L1-only 语义对齐。
//   L2（kind 'matrix'）永不走 Docker 平面（防越权：BFF 侧先拦，不依赖
//   Controller 侧 403）。
//   读 = archive 直读容器 agent.json（与 KB v2 同通道）
//   写 = exec 容器内 python GET→改 approval_level→整 PUT running-config
//        （live 热加载 + agent.json 落盘 + push_loop MinIO 同步；插件同款）
//
// 路由顺序（读/写一致）：REST 优先 → 404 时：
//   L1 + flag 开 → Docker 兜底；
//   否则区分「Worker 不在本会话 scope（跨团队 W8 防探测，404 隐藏）」与
//   「端点未上线（旧 Controller，GET 403 琥珀提示 / PUT 404 文案）」——评审
//   修订：二者不可混为一谈。
//
// 状态语义（UI 契约）：
//   GET 200 {approval_level, source}        → 显示
//   GET 403 {error, l2_hint}                → 琥珀提示（端点未上线/账号无权限，不报错）
//   GET 404 {error}                         → 整节隐藏（Worker 不存在/越权/两平面均不可用）
//   PUT 200 {ok, level, verified, source}   → toast 成功（verified=null → 前端重读）
//   PUT 400 {error}                         → 非法档位（未触碰上游）
//   PUT 403 {error}                         → 无权限（L2 设 OFF / team leader）
//   PUT 404 {error}                         → Worker 不存在/越权/端点未上线
//   PUT 409 {error}                         → 并发冲突，稍后重试

const ENDPOINT_MISSING_HINT = '审批端点未上线（Controller 升级含 #1216 审批端点后自动开放）';
const L2_READ_HINT = 'L2 账号无权限读取（需 L1 管理员凭据；Controller 升级含 #1216 审批端点后自动开放）';

// Docker 平面开关（评审修订：默认关；=1 / =true 显式开启）。
function dockerPlaneEnabled(): boolean {
  const v = process.env.AGENTTEAMS_APPROVAL_DOCKER_PLANE;
  return v === '1' || v === 'true';
}

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

// REST 404 时区分「跨团队 W8 防探测」vs「端点未上线」（评审修订）：查本会话
// scope 内的 Worker 列表（identity 头由 Controller 侧裁剪），目标在列 → 端点
// 未上线；不在列 → Worker 不可见（隐藏）。列表本身不可用 → null（调用方走
// 保守语义）。
async function workerVisibleInScope(
  request: NextRequest,
  controllerUrl: string,
  token: string | undefined,
  name: string,
): Promise<boolean | null> {
  try {
    const res = await fetch(`${controllerUrl.replace(/\/$/, '')}/api/v1/workers`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...identityHeaders(request),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as
      | Array<{ name?: unknown }>
      | { workers?: Array<{ name?: unknown }> }
      | null;
    const items = Array.isArray(data) ? data : (data?.workers ?? []);
    return items.some((w) => typeof w?.name === 'string' && w.name === name);
  } catch {
    return null;
  }
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
  const token = await resolveRestToken(request);
  const rest = await restApproval(request, controllerUrl, token, name, 'GET');
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
  // 404（旧 Controller 或跨团队 W8）/其他：
  //   L1 + Docker flag 开 → Docker 兜底；
  //   否则区分「端点未上线」（403 琥珀提示）与「Worker 不可见」（404 隐藏）。
  const dockerOk = isL1Session(request) && dockerPlaneEnabled();
  if (!dockerOk) {
    const visible = await workerVisibleInScope(request, controllerUrl, token, name);
    if (visible === true) {
      return NextResponse.json(
        { error: ENDPOINT_MISSING_HINT, l2_hint: ENDPOINT_MISSING_HINT },
        { status: 403 },
      );
    }
    if (visible === false) {
      return NextResponse.json(
        { error: 'Worker 不存在或无权限访问' },
        { status: 404 },
      );
    }
    // 列表不可用 → 保守回退：L2 琥珀提示（与旧版一致），L1 隐藏。
    if (!isL1Session(request)) {
      return NextResponse.json({ error: L2_READ_HINT, l2_hint: L2_READ_HINT }, { status: 403 });
    }
    return NextResponse.json({ error: '审批端点不可用' }, { status: 404 });
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
  const token = await resolveRestToken(request);

  // REST 平面优先（L1/L2 一致——评审修订：新 Controller 走正规边界，含审计，
  // 写路径不再绕开 #1216）。
  const rest = await restApproval(request, controllerUrl, token, name, 'PUT', {
    approval_level: level,
  });
  auditProxiedMutation(request, `/api/v1/workers/${name}/approval`, 'PUT', rest.status);
  if (rest.status === 200) {
    // best-effort 回读验证（#1216：409 透传、全量往返）。
    let verified: string | null = null;
    try {
      const back = await restApproval(request, controllerUrl, token, name, 'GET');
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

  // REST 404 + L1 + Docker flag 开 → Docker 兜底（旧 Controller 即开即用）。
  if (rest.status === 404 && l1 && dockerPlaneEnabled()) {
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
      return jsonFromError(e);
    }
  }

  if (rest.status === 404) {
    // 区分「跨团队 W8 防探测」vs「端点未上线」（评审修订）。
    const visible = await workerVisibleInScope(request, controllerUrl, token, name);
    if (visible === true) {
      const msg = l1 && !dockerPlaneEnabled()
        ? `${ENDPOINT_MISSING_HINT}；如需旧版通道可启用 AGENTTEAMS_APPROVAL_DOCKER_PLANE=1`
        : ENDPOINT_MISSING_HINT;
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    return NextResponse.json(
      {
        error:
          visible === false
            ? 'Worker 不存在或无权限访问'
            : '审批端点不可用（Controller 未升级 #1216 且 L1 通道不可用）',
      },
      { status: 404 },
    );
  }
  if (rest.status === 403) {
    return NextResponse.json(
      { error: detail || '无权限设置该级别（L2 不能设 OFF；team leader 只读）' },
      { status: 403 },
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
