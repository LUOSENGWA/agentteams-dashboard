// 工具执行安全（approval_level）Docker 数据面 —— workbench 插件同款
// （agentteams_connector/router.py L3984-4360 移植，9/18 装验定案「照插件做」）。
//
// 为什么需要这条数据面：
//   Controller >= #1216 才有 GET/PUT /api/v1/workers/{name}/approval（L2 团队
//   scope 读写）；旧 Controller（如生产 v1.2.3）该路由 404。插件在 1.2.4 之前
//   L1 可见可改，靠的就是下面这条 Controller Docker 代理通道——旧 Controller
//   即开即用。dashboard 与插件持同一 agentteams-admin SA token（投影 SA），
//   Docker 代理权限相同（GET/HEAD 恒放行；POST exec 两跳放行——插件实测）。
//
// 读（L1）：archive 直读容器 agent.json（与 KB v2 知识库同通道）：
//   GET {controller}/docker/v1.41/containers/agentteams-worker-{name}/archive?path=
//       /root/agentteams-fs/agents/{name}/.qwenpaw/workspaces/default/agent.json
//   （.copaw 布局兜底；候选 HEAD 探测 + 30min 缓存——插件同款）
//   注意：读的是 app 落盘的持久值。qwenpaw app 改 running-config 时经 per-file
//   path lock 写回 agent.json，live 值与持久值一致（#1216 pr-body 实锤）。
//
// 写（L1）：exec 容器内 python（/opt/venv/qwenpaw/bin/python）：
//   GET http://127.0.0.1:8088/api/workspace/running-config
//   → 只改 approval_level 单字段 → 整对象 PUT 回（上游 PUT 持久化收到的
//     完整对象，部分体抹字段——#1216 同款安全写）→ live 热加载（schedule_
//     agent_reload 无需重启）→ agent.json 落盘 → push_loop(5s) 同步 MinIO。
//   exec stdout 被 Docker 代理吞（插件实测）→ 结果写容器 /tmp 文件 +
//   archive 回读轮询（15s 上限）→ 读 agent.json 验证 → rm 临时文件。
//
// L2（或 Docker 代理不可用）→ 调用方 fallback 到 #1216 REST。
// copaw legacy worker：容器内无 running-config 路由 → py 报 ERR → 502
// 「worker 版本不支持」语义透传（插件同款版本门）。

export const APPROVAL_LEVELS = ['STRICT', 'SMART', 'AUTO', 'OFF'] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const DOCKER_API_VERSION = 'v1.41';
const AGENT_JSON_CACHE_TTL_MS = 30 * 60 * 1000;
const EXEC_POLL_SECONDS = 15;
const WORKER_APP_PORT = 8088;

export class ApprovalPlaneError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApprovalPlaneError';
    this.status = status;
  }
}

const agentJsonCache = new Map<string, { path: string; ts: number }>();

// ── 基础 fetch（Controller Docker 代理）────────────────────────────────

interface PlaneResp {
  status: number;
  body: Buffer;
}

async function dockerFetch(
  controllerUrl: string,
  token: string | undefined,
  path: string,
  init: { method?: string; json?: unknown; timeoutMs?: number },
): Promise<PlaneResp> {
  const url = `${controllerUrl.replace(/\/$/, '')}/docker/${DOCKER_API_VERSION}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeoutMs ?? 40_000),
    });
  } catch (err) {
    throw new ApprovalPlaneError(
      502,
      `Docker 代理请求失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

// ── 最小 ustar 单文件抽取（Docker archive 产物，KB v2 同款解析）─────────

function tarFirstFile(buf: Buffer): string | null {
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const typeflag = String.fromCharCode(h[156] || 0);
    const sizeStr = h.subarray(124, 136).toString('utf8').replace(/\0/g, '').trim();
    const size = parseInt(sizeStr || '0', 8);
    const dataStart = off + 512;
    if (typeflag === '0' && buf.length >= dataStart + (Number.isFinite(size) ? size : 0)) {
      return buf.subarray(dataStart, dataStart + (Number.isFinite(size) ? size : 0)).toString('utf8');
    }
    off += 512 + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
  }
  return null;
}

// ── agent.json 路径探测（插件 _kb_workspace 候选同款，30min 缓存）────────

export async function resolveAgentJsonPath(
  controllerUrl: string,
  token: string | undefined,
  name: string,
): Promise<string> {
  const now = Date.now();
  const hit = agentJsonCache.get(name);
  if (hit && now - hit.ts < AGENT_JSON_CACHE_TTL_MS) return hit.path;

  const container = `agentteams-worker-${name}`;
  const stInspect = await dockerFetch(controllerUrl, token, `/containers/${container}/json`, {
    timeoutMs: 15_000,
  });
  if (stInspect.status === 404) {
    throw new ApprovalPlaneError(404, `容器 ${container} 不存在（Worker 已删除或已停止）`);
  }
  if (stInspect.status === 401 || stInspect.status === 403) {
    throw new ApprovalPlaneError(stInspect.status, 'Docker 代理无权限（需 L1 管理员凭据）');
  }
  if (stInspect.status !== 200) {
    throw new ApprovalPlaneError(502, `容器探测失败（Docker API ${stInspect.status}）`);
  }

  const home = `/root/agentteams-fs/agents/${name}`;
  const candidates = [
    `${home}/.qwenpaw/workspaces/default/agent.json`,
    `${home}/.copaw/workspaces/default/agent.json`,
  ];
  for (const cand of candidates) {
    try {
      const st = await dockerFetch(controllerUrl, token, `/containers/${container}/archive?path=${encodeURIComponent(cand)}`, {
        method: 'HEAD',
        timeoutMs: 15_000,
      });
      if (st.status === 200 || st.status === 304) {
        agentJsonCache.set(name, { path: cand, ts: now });
        return cand;
      }
    } catch {
      // 候选探测失败继续下一个（布局差异）
    }
  }
  throw new ApprovalPlaneError(502, 'agent.json 候选路径均不可达（容器布局差异）');
}

// ── 读：archive 直读 agent.json → approval_level ───────────────────────

export async function readApprovalDocker(
  controllerUrl: string,
  token: string | undefined,
  name: string,
): Promise<string> {
  const path = await resolveAgentJsonPath(controllerUrl, token, name);
  const st = await dockerFetch(
    controllerUrl,
    token,
    `/containers/agentteams-worker-${name}/archive?path=${encodeURIComponent(path)}`,
    { timeoutMs: 30_000 },
  );
  if (st.status === 401 || st.status === 403) {
    throw new ApprovalPlaneError(st.status, 'Docker 代理无权限（需 L1 管理员凭据）');
  }
  if (st.status !== 200 && st.status !== 304) {
    throw new ApprovalPlaneError(502, `agent.json 读取失败（Docker API ${st.status}）`);
  }
  const text = tarFirstFile(st.body);
  if (!text) {
    throw new ApprovalPlaneError(502, 'agent.json archive 解析失败（tar 无文件成员）');
  }
  let parsed: { approval_level?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApprovalPlaneError(502, 'agent.json 解析失败（JSON 损坏）');
  }
  const level = String((parsed as { approval_level?: string }).approval_level || 'AUTO').toUpperCase();
  if (!(APPROVAL_LEVELS as readonly string[]).includes(level)) {
    throw new ApprovalPlaneError(502, `agent.json approval_level 值异常：${level}`);
  }
  return level;
}

// ── 写：exec 容器内 python（GET→改→整 PUT running-config）──────────────

function approvalPyCode(level: string): string {
  // 与插件 router.py _approval_exec py_code 逐字同构（worker 端口 8088）。
  return [
    'import urllib.request, json',
    `LEVEL = ${JSON.stringify(level)}`,
    `BASE = 'http://127.0.0.1:${WORKER_APP_PORT}'`,
    'def req(method, path, data=None):',
    "    r = urllib.request.Request(BASE + path, data=data,",
    "        headers={'Content-Type': 'application/json'}, method=method)",
    '    return urllib.request.urlopen(r, timeout=20)',
    'try:',
    "    cfg = json.loads(req('GET', '/api/workspace/running-config').read().decode())",
    "    cfg['approval_level'] = LEVEL",
    "    r = req('PUT', '/api/workspace/running-config', json.dumps(cfg).encode())",
    "    print('OK', LEVEL, r.status, r.read().decode()[:160])",
    'except Exception as e:',
    '    print(\'ERR\', repr(e))',
  ].join('\n');
}

async function execPythonInWorker(
  controllerUrl: string,
  token: string | undefined,
  name: string,
  pyCode: string,
  tmpPath: string,
): Promise<string> {
  const container = `agentteams-worker-${name}`;
  const b64 = Buffer.from(pyCode).toString('base64');
  const cmd = `echo ${b64} | base64 -d | /opt/venv/qwenpaw/bin/python > ${tmpPath} 2>&1; echo rc=$? >> ${tmpPath}`;

  const stExec = await dockerFetch(controllerUrl, token, `/containers/${container}/exec`, {
    method: 'POST',
    json: { Cmd: ['sh', '-c', cmd], Detach: true, Tty: false },
    timeoutMs: 30_000,
  });
  if (stExec.status === 401 || stExec.status === 403) {
    throw new ApprovalPlaneError(stExec.status, 'Docker 代理 exec 无权限（需 L1 管理员凭据）');
  }
  if (stExec.status === 404) {
    throw new ApprovalPlaneError(404, `容器 ${container} 不存在（Worker 已删除或已停止）`);
  }
  if (stExec.status !== 200 && stExec.status !== 201) {
    throw new ApprovalPlaneError(502, `exec 创建失败（Docker API ${stExec.status}）`);
  }
  let execId = '';
  try {
    execId = String((JSON.parse(stExec.body.toString('utf8')) as { Id?: string }).Id ?? '');
  } catch {
    throw new ApprovalPlaneError(502, 'exec 创建响应解析失败');
  }
  if (!execId) throw new ApprovalPlaneError(502, 'exec 创建未返回 Id');

  const stStart = await dockerFetch(controllerUrl, token, `/exec/${execId}/start`, {
    method: 'POST',
    json: { Detach: true, Tty: false },
    timeoutMs: 30_000,
  });
  if (stStart.status !== 200 && stStart.status !== 204) {
    throw new ApprovalPlaneError(502, `exec 启动失败（Docker API ${stStart.status}）`);
  }

  // 轮询结果文件（exec stdout 被代理吞——插件实测；15s 上限）。
  let out = '';
  for (let i = 0; i < EXEC_POLL_SECONDS; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const stPoll = await dockerFetch(
        controllerUrl,
        token,
        `/containers/${container}/archive?path=${encodeURIComponent(tmpPath)}`,
        { timeoutMs: 20_000 },
      );
      if (stPoll.status === 200 || stPoll.status === 304) {
        const text = tarFirstFile(stPoll.body) ?? '';
        if (text.includes('rc=')) {
          out = text;
          break;
        }
      }
    } catch {
      // 文件还没写出来，继续轮询
    }
  }
  if (!out.includes('rc=')) {
    throw new ApprovalPlaneError(502, '容器内命令 15s 未完成（结果文件未出现）');
  }

  // 清理临时文件（失败无害——/tmp 重启即清）。
  try {
    const stRm = await dockerFetch(controllerUrl, token, `/containers/${container}/exec`, {
      method: 'POST',
      json: { Cmd: ['sh', '-c', `rm -f ${tmpPath}`], Detach: true, Tty: false },
      timeoutMs: 15_000,
    });
    if (stRm.status === 200 || stRm.status === 201) {
      const rmId = String((JSON.parse(stRm.body.toString('utf8')) as { Id?: string }).Id ?? '');
      if (rmId) {
        await dockerFetch(controllerUrl, token, `/exec/${rmId}/start`, {
          method: 'POST',
          json: { Detach: true, Tty: false },
          timeoutMs: 15_000,
        });
      }
    }
  } catch {
    // 清理失败无害
  }
  return out;
}

export async function writeApprovalDocker(
  controllerUrl: string,
  token: string | undefined,
  name: string,
  level: ApprovalLevel,
): Promise<{ verified: string | null }> {
  const ts = Date.now();
  const tmp = `/tmp/.at-appr-${ts}`;
  const out = await execPythonInWorker(controllerUrl, token, name, approvalPyCode(level), tmp);
  const first = out.split('\n')[0] ?? '';
  if (!first.startsWith('OK')) {
    throw new ApprovalPlaneError(
      502,
      `容器内写入失败：${first.replace(/^ERR\s*/, '').slice(0, 200)}（worker app 不可达或版本不支持 running-config）`,
    );
  }
  // 验证 agent.json 落地（best-effort——写回经 per-file path lock，偶发延迟时
  // verified=null 由前端重读，与插件「设置成功但未回读」同语义）。
  let verified: string | null = null;
  try {
    verified = await readApprovalDocker(controllerUrl, token, name);
  } catch {
    verified = null;
  }
  return { verified };
}
