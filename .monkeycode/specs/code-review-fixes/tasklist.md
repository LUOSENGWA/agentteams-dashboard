# 需求实施计划

> 依据：`docs/code-review-issues.md`（30 个已验证问题，编号 SEC-01~10 / FUNC-01~09 / UI-01~07 / A11Y-01~04 / ARCH-01~02）
> RBAC 实现模式参考：`.monkeycode/specs/server-side-rbac-audit/design.md`
> 说明：所有测试任务均为必做（用户已确认执行全部任务）。

- [x] 1. RBAC 补齐与凭据掩码（SEC-01/02/03）
  - [x] 1.1 Nacos 配置 GET 接口补 RBAC 并掩码密码（SEC-01）
    - `src/app/api/agentteams/skills/nacos/config/route.ts` GET 增加 `enforceLevelOnlyRbac(request, 'view', 'skill.nacos.config', 'config')`（对齐 PUT 的既有模式）
    - 响应中 `password` 字段掩码为固定占位符，PUT 侧忽略掩码占位值避免把掩码写回存储
    - 排查前端设置面板对掩码回显值的处理路径
  - [x] 1.2 MinIO 存储读接口补 RBAC（SEC-02）
    - `storage/download`、`storage/presign` GET、`storage/buckets` GET、`storage/buckets/[bucket]/objects` GET 四处增加 `enforceLevelOnlyRbac(request, 'view', ...)`
    - 下载路由复用 `isSensitiveFileName` 过滤 worker 凭据类文件
  - [x] 1.3 Team 文件读接口对齐 worker 路由防护（SEC-03）
    - `teams/[name]/files` GET 与 `teams/[name]/files/download` GET 增加 `enforceServerSideRbac(request, 'view', 'team', name)`
    - 下载路由应用 `isSensitiveFileName` 过滤（对齐 `workers/[name]/files` 既有实现）
  - [x] 1.4 为上述路由编写 RBAC 拒绝/放行单元测试（覆盖 SEC-01/02/03）
    - level 1 会话访问存储读接口返回 403，level 3 放行
    - Nacos GET 响应断言无明文 password
    - team 文件下载对敏感文件名返回 404

- [x] 2. XSS 防护与 token 转发收敛（SEC-04/05）
  - [x] 2.1 聊天 Markdown 链路接入 rehype-sanitize（SEC-04）
    - 安装 `rehype-sanitize`，在 `markdown-message.tsx:349` 的 rehype 插件链中 `rehypeRaw` 之后插入 sanitize
    - 定义 schema：放行 GFM/math/highlight 所需标签与属性，拒绝事件属性与脚本类标签
  - [x] 2.2 Matrix 代理默认强制 homeserver 允许列表（SEC-05）
    - `proxy-helper.ts` 的 `validateHomeserverUrl` 调用改为 `requireAllowlist: true`（对齐 debug-log 既有模式）
    - 处理未配置 `MATRIX_HOMESERVER_ALLOWLIST` 时的兜底行为，更新 `.env.example` 说明
  - [x] 2.3 属性测试：sanitize schema 对任意输入拒绝 on* 事件属性与 script/iframe 标签（fast-check）
    - 用 fast-check 生成随机 HTML 片段，断言净化输出不含脚本向量（SEC-04）
    - 用 fast-check 生成随机 host，断言未入允许列表的 host 被拒绝（SEC-05）

- [x] 3. 服务端其余安全问题（SEC-06~10）
  - [x] 3.1 `setup/status` 增加 token gate（SEC-06）：middleware PUBLIC_PATHS 移除或路由内校验，未认证时剥离 SA token
  - [x] 3.2 容器日志接口收紧（SEC-07）：`logs/[component]` 增加 `enforceLevelOnlyRbac`，`resolveContainerName` 收敛到已知组件白名单
  - [x] 3.3 插件路由鉴权统一（SEC-08）：`dashboard/plugins` 与 `[id]` 改用 Dashboard 会话 + level 3 RBAC，GET 列表至少要求已登录
  - [x] 3.4 登录错误脱敏（SEC-09）：`auth/login` 外层 catch 返回通用文案，原始错误仅服务端日志
  - [x] 3.5 审计 sourceIp 防伪造（SEC-10）：`server-auth.ts` 仅在可信代理配置下采信 `x-forwarded-for`
  - [x] 3.6 为 3.1-3.5 编写路由级单元测试
    - 未认证访问 `setup/status` 不返回内部响应/不携带 SA token
    - 未知组件名日志请求返回 400/403
    - 插件上传对无 Dashboard 会话的请求返回 401
    - login 失败响应不包含内部异常文本

- [x] 4. Matrix 同步与状态管理缺陷修复（FUNC-01~04）
  - [x] 4.1 修复同步循环停摆（FUNC-01）：`use-global-matrix-sync.ts` 对 `busyRef` 做分代化处理，提前返回路径重新调度，cleanup 后旧请求结果按代丢弃
  - [x] 4.2 修复房间改名丢失（FUNC-02）：`use-matrix.ts` setRoomMeta 比较条件纳入 `roomName`
  - [x] 4.3 修复自动重连挂载竞态（FUNC-03）：`agentteams-store.ts` 初始订阅时对已处于断开态的 store 调用一次 `startAutoReconnect()`
  - [x] 4.4 修复深链接丢失（FUNC-04）：`ChatSection.tsx` 仅在 `!isLoading && rooms` 命中时消费 pending 值，未命中时保留
  - [x] 4.5 为 4.1-4.4 编写单元测试（重点：busyRef 分代行为与 pending 消费时序）
    - 重挂载场景下新 effect 首轮 poll 可正常调度并持续轮询
    - 仅 roomName 变化的补丁能写入 store
    - 初始断开态下订阅建立即启动重连定时器
    - 列表加载中到达的深链接在加载完成后仍生效

- [x] 5. SSE 取消与渲染性能（FUNC-05/06）
  - [x] 5.1 `collectSSE` 增加 `signal` 参数（FUNC-05）：`wen-tian/index.tsx` 诊断流程接入 AbortController，卸载/重试时 abort；修复 703/1218 两处 `[api]` 无效依赖（消除全部 lint warning）
  - [x] 5.2 外壳 store 订阅 selector 化（FUNC-06）：`agent-teams-dashboard.tsx:88-90` 两个无 selector 订阅改为逐字段选择（对齐 91 行既有写法）
  - [ ] 5.3 lint 验证与 wen-tian 回归测试
    - `npm run lint` 输出 0 warning
    - abort 后 SSE 生成器终止、不再产生新事件

- [x] 6. 检查点 - 确保所有测试通过，如有疑问请询问用户（安全批 + 核心功能批完成，运行 `npm run lint && npm run typecheck && npm test`）

- [x] 7. 低优先级健壮性修复（FUNC-07~10）
  - [x] 7.1 HITL 审批关键词多语言（FUNC-07）：`hitl-inbox.ts` `isHitlResolutionReply` 扩展 deny/reject 等关键词集合
  - [x] 7.2 Nacos SSE 退避与清理（FUNC-08）：`use-nacos-events.ts` 指数退避上限、`es` 引用 ref 化修复清理竞态
  - [x] 7.3 共享 tick（FUNC-09）：`use-worker-session-state.ts` `useSessionTick` 改为模块级单 interval + 订阅计数
  - [x] 7.4 为退避逻辑与共享 tick 编写单元测试
    - 连续失败时重连间隔按退避序列增长且不超过上限
    - 多组件共享同一 tick，卸载全部组件后 interval 清理
  - [x] 7.5 知识库 runtime 过滤（FUNC-10）：`knowledge-section.tsx` worker 下拉仅列 `runtime === 'qwenpaw'`，无 qwenpaw Worker 时显示「知识库当前仅支持 QwenPaw 运行时」空态说明（用户 2026-09-20 确认口径）

- [x] 8. 主题与视觉修复（UI-01~05）
  - [x] 8.1 状态徽章配色修复（UI-01）：`projects-section.tsx`/`tasks-section.tsx` 改为 `text-*-700 dark:text-*-400` 双模式，抽取共享常量模块消除双份镜像 map
  - [x] 8.2 可视化配色接入主题 token（UI-02）：`topology-canvas.tsx` 色板改用 CSS 变量，连带 `overview-section` recharts、`phase-colors`、`agent-health`、`worker-session-dot`；去掉无 onClick 的 pointer 光标
  - [x] 8.3 quickstart 无效 CSS 修复（UI-03）：`rgba(var(--primary),0.1)` 改为 Tailwind 透明度类，完成开关补 `aria-pressed`
  - [x] 8.4 mermaid 主题跟随（UI-04）：`mermaid-renderer.tsx` 按解析主题选择 mermaid theme，显式声明 `securityLevel: 'strict'`
  - [x] 8.5 浅色主题对比度达标（UI-05）：`globals.css` muted-foreground 加深、聊天链接/错误色加深、theme-tab emerald 预设前景改深色
  - [x] 8.6 为对比度计算编写属性测试（主题 token 满足 WCAG AA）
    - 对 light/dark/high-contrast 三组核心 token 计算 WCAG 对比度，正文级组合 ≥ 4.5:1

- [x] 9. 可访问性修复（A11Y-01~04）
  - [x] 9.1 图标按钮补齐可访问名称（A11Y-01）：header/notification-popover/markdown-message/theme-tab/worker-files-panel/models-section 共 7 处，复制按钮补 `group-focus-within`
  - [x] 9.2 分隔条键盘操作（A11Y-02）：`ChatRoom.tsx` 补 `onKeyDown` 方向键步进，`chat-room-sidebar.tsx` 补 `tabIndex`
  - [x] 9.3 Chat 布局响应式（A11Y-03）：小屏默认折叠成员/文件侧栏，抽屉化非消息面板
  - [x] 9.4 Artifacts 响应式（A11Y-04）：小屏改上下布局，替换内联 `calc(100vh-320px)`
  - [x] 9.5 axe-core 可访问性检查（devDependencies 已含 axe-core）
    - 对 workers/chat/settings 关键 section 断言无 critical violation

- [x] 10. 组件与架构一致性（UI-06/07、ARCH-01/02）
  - [x] 10.1 收敛手写组件（UI-06）：audit/security 手写 table、ChatRoom 原生 select、worker-files-panel 的 a 标签按钮替换为 shadcn 既有原语
  - [x] 10.2 小字号收敛（UI-07）：`text-[8px]`/`[9px]` 离群值提升至可读下限
  - [x] 10.3 统一加载/错误态（ARCH-01）：audit/overview/tasks/artifacts/projects/knowledge 接入 SectionSkeleton 与 ApiErrorState
  - [x] 10.4 版本号统一（ARCH-02）：确立 package.json 为版本源，修正 README 引用
  - [x] 10.5 一致性回归测试
    - audit/security 表格断言使用 shadcn Table 结构
    - 各 section 加载态断言渲染 skeleton 而非裸文本

- [ ] 11. 检查点 - 确保所有测试通过，如有疑问请询问用户（运行 `npm run lint && npm run typecheck && npm test && npm run build`，确认 lint 0 warning）
