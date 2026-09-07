# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent while performing [specific task description] should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[User Instruction Summary]
- Date: 2026-08-11
- Context: PR patch 应用后项目梳理阶段
- Instructions:
  - 主题系统验证后自动执行项目文档整理和僵尸文件清理
  - 使用中文交流
  - 保持 main 分支干净，每次变更前需验证 typecheck/lint/test

[Project Knowledge Summary]
- Date: 2026-08-16
- Context: 整体 review 后执行死代码清理
- Category: Workflow & Collaboration
- Instructions:
  - .monkeycode/docs/ 目录是 Agent 内部知识源，docs/ 目录是用户可见文档
  - 已完成的任务书应归档到 .monkeycode/specs/{feature-name}/task-book.md
  - 2026-08-11 计划清理的 skills-section.tsx 已删除；2026-08-16 又删除了 policy-engine/policy-store/remediation-engine（313 行孤立引用环）、a2ui/index.ts barrel、src/app/api/route.ts 残留、team-create-dialog.test.ts 重复测试
  - 仍存在 ensure-ai 三重死链（middleware PUBLIC_PATHS 条目 + agentteams-api.ts 的 ensureAiGateway + integration 测试引用），路由本身不存在，待后续清理
  - 旧条 "GET /api/agentteams/audit 是 admin-only" 已于 2026-09-07 升级为 L2 自审 / L3 全审模型，详见下方 09-07 条目

[Project Knowledge Summary]
- Date: 2026-08-21
- Context: 修改 Beta 设置与 Overview 运行信息面板时执行构建验证
- Category: Build Methods | Testing Methods
- Instructions:
  - typecheck 必须用 ./node_modules/.bin/tsc --noEmit 或 npm run typecheck；直接 npx tsc 会误装废弃的 tsc@2.0.4 包报错
  - vitest 4 已移除 --reporter=basic，直接运行 ./node_modules/.bin/vitest run 或 npm test
  - 验证顺序：typecheck -> eslint（仅改动的文件）-> vitest run（全量 129 文件约 3 分钟）

[Project Knowledge Summary]
- Date: 2026-08-25
- Context: 推进服务端治理 + ChatRoom 重构时落定的项目约定
- Category: Operations & Deployment | Environment Configuration | Workflow & Collaboration
- Instructions:
  - 服务端审计默认落 `${cwd}/logs/audit.log.jsonl`，生产部署必须通过 `AGENTTEAMS_AUDIT_LOG_PATH` 指向持久化卷（默认路径已加入 `.gitignore` `/logs/`）。rotate 策略：单文件 ≥10 MB 或每日触发；归档保留 30 份
  - 写操作路由的 RBAC 现在服务端强制：workers/teams/managers/humans 的 POST/PUT/DELETE/wake/sleep/ensure-ready 走 `enforceServerSideRbac`（带 accessibleWorkers/accessibleTeams 范围检查）；storage/skills/projects/gateway/debug-log/wen-tian/mcps/worker 文件/team 文件 等全局资源走 `enforceLevelOnlyRbac`（纯等级判断）。两类 403 都自动写 warning 审计
  - middleware 在 Higress session 验证通过后注入 `x-agentteams-user` / `x-agentteams-user-level`，proxy-helper 透传给 Controller。修改相关代码时记得：identity 头来自 middleware 不是浏览器，不要直接 `request.headers.get('authorization')` 当成 user 头
  - `recordToolCalls(workerName, eventId, blockCount, now?, structuredKeys?)` 第 5 个参数 `structuredKeys` 是 v1 协议（`org.agentteams.run`）结构化 tool_call 的 id 列表。传入时跳过 event-delta 计数，仅按 id 去重。纯 v0/无结构化数据时维持原 eventId 增量语义
  - `usePersistedDraft(roomId)` 暴露 `setValueLocal`（不写 storage）专供 edit session 回填——直接用 `setValue` 会把编辑中的内容持久化，下次进房间会看到。ChatRoom.tsx 的 handleRequestEditLast / handleCancelEdit 都用 setValueLocal
  - feature-implementer skill 要求每个 task 完成后停下来等用户确认，不要自动推进下一 task。本次按此规范逐项推进 P0-1 / P0-2 / P1-4 Phase1 / RBAC 扩展 / 审计 viewer，每项独立 commit + 验证
  - PR 风格沿用项目约定：标题 `type(scope): summary`，正文包含验证证据（vitest 数字）、兼容性声明、风险与关注点
  - `GET /api/agentteams/audit` 旧版 admin-only 入口已被 2026-09-07 升级版覆盖（L2 自审 / L3 全审，详见下方 09-07 条目）；前端 `useAuditEvents` hook 把 403 当 data 返回而非抛错，UI 走 inline notice 分支渲染"需要审计权限"
   - 仍未接 RBAC 的写路由：`/api/agentteams/setup/*`（装机入口必须在 RBAC 前可达）、`/api/agentteams/packages/*`（由 Controller 侧 gate）、`/api/agentteams/models/probe`（只读）；所有 GET 路由保持开放

[Project Knowledge Summary]
- Date: 2026-09-03
- Context: 实现总览 HITL 收件箱功能（对照 2026 竞品趋势）
- Category: Build Methods | Testing Methods | Workflow & Collaboration
- Instructions:
  - HITL 收件箱核心模块：`src/lib/hitl-inbox.ts`（zustand store + Matrix 事件提取），支持 Tool Guard 文本协议 + v1 `org.agentteams.run` 确认协议
  - `extractConfirmationFromEvent` 从 Matrix 事件提取确认请求；`ingestHitlTimelineEvents` 按时间排序摄入，处理 m.replace 修订（保留确认则 upsert，移除确认则 dropByEventId）
  - 全局 sync 集成：`use-global-matrix-sync.ts` 的 `ingestWorkflowEvents` 旁增加 `ingestHitlTimelineEvents` 调用，历史加载（最近 10 房间 × 30 条）和实时 sync 都摄入
  - 深链模式：store 暴露 `takePendingChatRoomId` / `takePendingProjectKey` 原子消费方法，组件在渲染期调用避免 effect 里 setState 触发 lint 错误
  - 总览 UI：`src/components/dashboard/sections/hitl-inbox-card.tsx` 显示待审批工具 + 暂停项目，点击跳转对应 section
  - 单测覆盖：`hitl-inbox.test.ts`（9 个测试）+ `use-global-matrix-sync.test.tsx` 新增确认采集测试（共 17 个测试通过）
  - eslint 规则 `react-hooks/set-state-in-effect` 禁止在 effect 里同步 setState，采用渲染期原子消费模式绕过
  - typecheck 用 `./node_modules/.bin/tsc --noEmit`，vitest 用 `./node_modules/.bin/vitest run`，eslint 仅跑改动文件

[Project Knowledge Summary]
- Date: 2026-09-07
- Context: 闭环 Dashboard 侧栏 + composer 活动轨道 + Worker 一键进聊天 + 审计 L2 自审权限
- Category: Workflow & Collaboration | Environment Configuration
- Instructions:
  - `GET /api/agentteams/audit` 现已支持 L2+ 访问：L2 走 `scope: 'self'`（仅看自己 actor 的事件，server 端强制 `query.actor = identity.name`，客户端伪造参数无法绕过）；L3+ 走 `scope: 'all'` 全公司视角。L1/无身份仍 403。**注意**：上方 2026-09-03 旧条"audit admin-only"已过期
  - 403 响应体新增 `observedLevel` / `requiredLevel`，前端 `useAuditEvents` 透传；`audit-section.tsx` 区分两种失败文案：身份头缺失（dev/AGENTTEAMS_AUTH_DISABLED）vs 等级不足
  - 侧栏房间按 `groupRoomsByType` 分组（team/agent/manager/human/unknown），每行渲染 `lastMessagePreview || parentTeam || id` 兜底，`extractMessagePreview` 已知处理 m.text / m.image / m.file / m.audio / m.video / 非 m.room.message / 空 body
  - 跨区聊天跳转统一走 `src/lib/open-chat-room.ts:openChatRoom(roomId)`，空 roomId 静默忽略。`workers-section` / `hitl-inbox-card` / `tasks-section` 都用这个入口
  - composer 上方 `AgentActivityTrack` 展示任务进度 + HITL 待办
  - 守卫写法：渲染可选字段时禁止用 `value || value` 这种"value 可能是 undefined"的回退（会渲染字符串"undefined"），用 `value ? <Badge>...</Badge> : null` 替代
  - 本次 commit 风格：1 个 feat commit + 1 个 fix commit 紧跟其后，fix 不 amend 进 feat 保持历史清晰
  - `git push` 由用户口头确认后执行，未授权不主动 push
