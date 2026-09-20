# 服务端 API 模块

## 边界与认证

`src/app/api/` 是浏览器与外部服务之间的服务端边界。`src/middleware.ts` 保护 `/dashboard/*` 和大多数 `/api/agentteams/*` 请求（`/api/agentteams/setup/status/` 已移出公开路径，仅认证后由首页按需调用）；setup 状态和 ensure 路由服务于启动流程。Controller 代理优先使用 `AGENTTEAMS_AUTH_TOKEN`，否则逐请求读取 `AGENTTEAMS_AUTH_TOKEN_FILE` 以支持令牌轮转。

### 服务端 RBAC（ defense-in-depth 第二道门）

middleware 是权威身份门（`x-agentteams-level` 等 identity 头），但 identity 头可被伪造的部署场景下，路由层再用 `src/lib/server-auth.ts` 的 `enforceServerSideRbac` / `enforceLevelOnlyRbac` 做第二道校验，权限判定复用 `src/lib/rbac-engine.ts`（L1=view，L2=+wake/sleep/ensure-ready，L3=全部+`manage`）。已接入的路由：存储读路径（`view` 门 + 敏感文件过滤）、teams 文件下载（双门）、`logs/[component]`（`manage` 门 + 组件白名单，未知组件 404）、Nacos 配置写、plugins 读写（GET 已登录、POST/DELETE L3，弃用旧 Higress 会话校验）。`sourceIp` 仅在 `AGENTTEAMS_TRUST_PROXY=true` 时采信 `x-forwarded-for`。

## 路由分组

| 路径 | 目标 | 职责 |
|---|---|---|
| `/api/agentteams/{workers,teams,humans,managers}` | Controller | 资源 CRUD |
| `/api/agentteams/workers/{name}/*` | Controller | 状态、唤醒、休眠和就绪 |
| `/api/agentteams/{healthz,status,version,cluster-status,setup}` | Controller | 健康、版本、集群和初始化 |
| `/api/agentteams/storage/*` | MinIO SDK | bucket、对象、上传下载与预签名 |
| `/api/agentteams/skills` | MinIO SDK | 技能列表、搜索、分页与上传（含覆盖） |
| `/api/agentteams/skills/[name]` | MinIO SDK | 单个技能读取、更新与删除 |
| `/api/agentteams/skills/[name]/download` | MinIO SDK | 下载技能 ZIP 包 |
| `/api/agentteams/skills/nacos/config` | 本地文件 | Nacos 配置读写 |
| `/api/agentteams/skills/nacos/sync` | Nacos API | 触发技能元数据同步 |
| `/api/agentteams/skills/nacos/[name]/download` | Nacos + MinIO | 按需拉取并缓存 Nacos 技能内容 |
| `/api/agentteams/workers/[name]/skills` | Controller | 向 Worker 推送技能包 |
| `/api/agentteams/debug-log` | Controller + Matrix | 一键收集调试日志：容器诊断/日志、Agent 会话、Matrix 消息，脱敏后打包 ZIP 下载 |
| `/api/matrix/*` | Matrix Client-Server API | 登录、同步、房间、消息、媒体和输入状态 |
| `/api/higress/*` | Higress Console | Provider 和 AI Route 管理 |

`proxy-helper.ts` 是 Controller 路由公共出口：它验证可选 `controllerUrl`、应用 10 秒超时、透传授权与上游响应，并给浏览器响应设置禁止缓存头。Matrix `login`/`media` 代理以 `requireAllowlist: true` 强制 homeserver 允许列表（`MATRIX_HOMESERVER_ALLOWLIST`，未配置时仅放行同源）。Matrix 路由校验 homeserver 允许列表；Higress 路由校验 Console 主机、转发会话 Cookie，并从 Provider 响应移除 Token 值。存储读路径（bucket 列表、对象列表、下载、预签名）要求请求者具备 `view` 权限并对 `download`/`presign` 过滤敏感文件（`src/lib/sensitive-files.ts`）。

## 外部模式

`AGENTTEAMS_HIGRESS_ADAPTER_MODE=external` 时，Worker 与 Manager 的创建、更新，以及 Worker 唤醒和就绪操作会检查请求模型别名是否能绑定到可用 Provider、AI Route 和目标模型。带遗留 `modelProvider` 的请求返回迁移错误。

## 错误语义

Controller 网络或超时错误返回 `502`，上游业务状态原样透传。Higress 路由将输入、会话、部署配置和代理错误分别映射为 `400`、`401`、`503`、`502`。MinIO 将参数、已存在 bucket 和不存在 bucket 分别映射为 `400`、`409`、`404`。
