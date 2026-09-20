# 更新日志

本文件记录 AgentTeams Dashboard 的版本发布历史。

## v1.3.0 (2026-09-20)

### New Features

- **知识库面板**：新增集群 Worker 记忆只读视图，浏览 MEMORY.md 与 memory、digest 目录，支持分页加载、wikilink 关系图谱；数据面来自 QwenPaw 运行时 workspace-files 端点（`/api/agentteams/workers/{name}/workspace-files/{tree|file-metadata|file-content}`），Worker 下拉仅列 QwenPaw 实例，无可用实例时显示说明性空态
- **任务看板（项目页）**：接入 Controller projects API，支持 DAG/loop 计划的列表、详情、节点任务查看，以及暂停/恢复/重规划/取消节点等干预操作
  - 项目时间线面板：详情面板底部「干预记录」折叠区，调用 `GET /api/v1/projects/{id}/history` 与 `…/history/{ts}`，按时间倒序列出每次干预前的 workflow 快照元数据（状态、标题、操作人、时间、暂停原因等审计字段）
  - 项目 API 降级横幅：Controller 端点 404（API 未部署）/ 500（Controller 故障）差异化提示，附原始错误信息
- **技能中心**：重构技能管理为集中化技能仓库，支持自定义技能上传、版本管理与 Nacos 注册中心同步分发，技能选择下沉到 Worker 创建流程
- **Higress AI 网关配置**：模型厂商、模型名称适配与 AI 路由策略的统一配置界面，多服务商路由与模型别名绑定，凭据仅提交 Higress 的服务端代理链路
- **聊天体验升级**：虚拟化消息时间线、线程面板、消息编辑与已读回执；会话列表按最新消息排序并区分未读状态；流式输出经 `m.replace` 中间态渲染（逐字符打字机 + 光标动画）
  - 运行时块协议 v1（`org.agentteams.run`）：带版本号的 discriminated union（text/thinking/tool_call/confirmation/error），结构化 tool_call 以 `tool_call_id` 为权威去重键，未知版本降级到文本启发式
  - ChatRoom 拆分 Phase 1：抽出 `usePersistedDraft`（每房间草稿持久化）、`useFileUpload`（file → mxc + m.image/m.file 状态机）、`useFileDropZone` + `DragDropOverlay`（拖拽上传层）
  - 思考、工具调用、工作流、A2UI 与人机确认（HITL）卡片渲染，确认关键词中英双语识别
- **Worker 卡片 v2 与文件面板**：聊天内 Worker 卡片改版，文件面板明确反映对象存储同步状态，聊天区域与工作目录区域宽度可调
- **导航分组化**：13 项扁平导航重构为分组折叠结构，可见入口压缩至 5 个，保持全部功能可达
- **资源删除锁**：Worker 与团队删除执行期间在对应资源上呈现锁定状态，避免并发修改
- **审计中心**：admin-only「审计」侧边栏区块，渲染服务端 JSONL 审计事件表格，支持 entity_type 过滤与 15s 轮询；新增 `useAuditEvents` hook

### Security

- 服务端 RBAC 落地：middleware 作为权威权限门，服务端 API 增加第二道级别校门——worker/team 资源走 `enforceServerSideRbac`（细粒度），storage/skills/projects/gateway/debug-log/wen-tian/mcps 等全局资源走 `enforceLevelOnlyRbac`（`checkPermissionByLevel` 纯等级决策）
- append-only JSONL 审计日志（10 MB 自动 rotate，保留 30 份归档，路径可经 `AGENTTEAMS_AUDIT_LOG_PATH` 覆盖）；403 拒绝自动写 warning 审计；客户端 `auditMutation` 镜像审计事件
- `AGENTTEAMS_AUTH_DISABLED` 本地模式注入合成本地身份（默认 `local-admin`/L3，可经 `AGENTTEAMS_LOCAL_USER*` 覆盖），并覆盖客户端伪造的同名身份头
- Nacos 凭据等敏感信息在 API 响应中掩码
- 存储视图与 teams files 接口增加访问门控与敏感对象过滤
- `setup`、`status` 端点移出免认证公共路径
- Debug 日志组件白名单收敛至固定容器名，需 manage 权限
- 插件系统会话化隔离；`sourceIp` 仅在显式信任头存在时采信
- 聊天 Markdown 渲染接入 rehype-sanitize 白名单管线（`src/components/dashboard/sections/chat/sanitize-schema.ts`），过滤 AI 输出中的原始 HTML

### Bug Fixes

- HITL 确认关键词大小写不敏感精确匹配，避免误触发
- Nacos SSE 断线改为指数退避重连（5s 起步、60s 封顶），清理竞态句柄
- 全局会话心跳合并为模块级单一 interval（`useSessionTick`），随订阅数自动启停
- Worker 自动重连、深链接先读缓存后拉取、SSE 中止传播、同步忙碌态竞态、`setRoomMeta` 增量补丁
- 知识库 502/404 透传 Controller 错误详情而非笼统报错
- 服务端解析 LLM SSE 流增加缓冲，消除跨网络分块 token 丢失风险

### Improvements

- 亮色/暗色/高对比三主题全部正文组合对比度 ≥ 4.5:1（`src/lib/theme/contrast.test.ts` 自动化守护）
- 状态徽章收敛为共享双模式配色模块（`src/lib/status-colors.ts`）；拓扑画布连线跟随主题 token 并补齐 svg role/aria
- 全局字号收敛对齐设计 token；区块加载态统一 Skeleton
- 图标按钮补齐 aria-label，分隔条支持方向键步进，窄屏聊天自动折叠房间列表，工件树小屏纵排；axe 自动扫描接入（`a11y-axe.test.tsx`）

### Maintenance

- 废弃上游补丁流程：删除 `install/patches/` 与 `install/submit-pr.sh`，Dashboard 安装器集成已经上游 PR #1075 合入（后续 #1081/#1118/#1162/#1195），Install Test 工作流移除补丁校验步骤；后续上游变更一律通过 PR 提交

### Documentation

- 项目 Wiki 全量同步：服务端 API（RBAC 第二道门）、Dashboard 模块（sanitize 管线、知识库口径）
- 代码审查报告收档：33 项问题全部修复或记录取舍（`docs/code-review-issues.md`）

### Quality

- 测试规模：193 个测试文件 / 1812 个用例全绿（较上一节点 1256 例增长 44%）；lint 0 问题；`npm run build` 通过
- 新增主题对比度性质测试、axe 扫描、一致性回归测试与知识库/聊天/RBAC/审计多组组件测试

### Contributors

- @nillikechatchat
- @monkeycode-ai（平台 AI 协作者）

## v1.2.3.1 (2026-08-18)

### New Features

- **任务看板主数据源切换为 Controller API（D5/D8）**：看板数据优先从 Controller API 拉取，MinIO 作为回退源，提升数据一致性与可用性
- **Chat 空状态插图**：Bot 渐变插图 + 消息角标，替代原单一图标
- **流式打字机效果**：流式输出逐字符展示 + 光标动画；纯文本走轻量渲染路径，块级内容走完整 Markdown 渲染
- **工具卡片结构化升级**：
  - 状态点 + 状态徽标变色（成功绿 / 失败红 / 进行中紫），折叠态直接展示错误首行摘要
  - IN/OUT 输入输出区块徽标
  - streaming / thinking 卡片统一圆角与悬停阴影
  - workflow 步骤字形三态：完成勾 / 失败叉 / 进行中转圈 / 待执行虚线环

### Bug Fixes

- 修复流式追加时打字机头部重置（每追加一个字符就从头部重新打字）
- 修复 workflow 待执行步骤误显示转圈动画
- 修复 CI 失败：清理未使用的 `StreamingCursor`，并将 TypingEffect 改为 render-phase 状态调整，规避 eslint `react-hooks/set-state-in-effect` 报错

### Contributors

- @nillikechatchat（yuanhenglizhen2050@163.com）
- @LUOSENGWA（101017075+LUOSENGWA）
- @monkeycode-ai（平台 AI 协作者）

### Version Updates

- Dashboard 发布标签从 `v1.2.3` 更新至 `v1.2.3.1`

## v1.2.4 (2026-08-14)

### New Features

- **问天插件：AI 深度诊断与日志分析合并为「AI 日志分析诊断」**：
  - 填写症状描述 → 点击「AI 日志分析诊断」，一次完成日志实时采集（容器日志 / Agent 会话 / Matrix 消息）与 AI 分析，SSE 进度条 + 流式报告输出；移除原独立的「AI 诊断」按钮与「开始日志分析」入口
  - 诊断 Prompt 重写并贴合 AgentTeams：角色为平台资深 SRE，内置 Controller/Worker（OpenClaw/Hermes/CoPaw）/团队/Human/Matrix/MinIO/Higress AI 网关模块知识与常见故障域清单；输出结构带严重程度徽章、诊断概要表、事件时间线表、按置信度排序的根因分析、可执行修复命令（bash/yaml 代码块）
  - **日志真实进入 Prompt**：容器日志尾部（单容器 16KB / 总量 96KB 上限）、docker inspect facts（state/exitCode/OOMKilled/重启次数）、Agent 会话摘录（12 个文件 / 32KB 上限）随症状描述与 Dashboard 环境快照一起交给 LLM；此前日志只做统计未进入分析
  - 诊断模型可选：默认模型（服务器 `AGENTTEAMS_DEFAULT_MODEL`）、「模型管理」已配置的服务商模型（经 Higress AI 路由解析）、内置别名与自定义别名；API Key 仍仅保存在服务端
  - 报告渲染美化：react-markdown 自定义渲染器（章节分隔线、表格样式、代码块复制按钮、流式光标），报告头部显示所用模型与时间，支持一键复制全文

### Improvements

- **日志收集迁入问天诊断页**：原设置对话框「日志收集」页签整体迁移为「AI 日志分析诊断」卡片的「日志收集配置」功能区（时间范围 / 容器过滤 / 房间过滤 / PII 脱敏 / Matrix 状态提示），参数直接供 AI 诊断复用；设置对话框由 5 个页签精简为 4 个
- 修复服务端解析 LLM SSE 流未缓冲导致的 token 丢失风险（`data:` JSON 跨网络分块时可能被丢弃）
- 清理问天插件死代码（`collectAndAnalyzeLogs`、`InfraLine`、`SEVERITY_LABELS` 等）

## v1.2.3 (2026-08-13)

### New Features

- **问天诊断插件 (WenTian)**: 新增运行时诊断助手插件，提供：
  - 集群健康概览：Worker/Team/Human 分布、基础设施状态（MinIO/Matrix/Higress）、版本一致性检查
  - AI 深度诊断：输入症状描述，调用 AgentTeams SRE 专家 Prompt 模板，输出结构化 Markdown 报告（问题摘要、日志时间线表格、根因分析、临时/根本修复方案、预防措施、需补充信息）
  - 日志分析：SSE 实时进度条展示采集进度（扫描容器 → 拉取日志 → 会话导出 → Matrix 消息 → AI 分析），结果始终可见
  - 诊断报告可一键复制到剪贴板

### Improvements

- **AI 诊断结果 Markdown 渲染**：诊断结果和日志分析结果均支持 GFM Markdown 渲染（表格、代码块、列表等）
- **问天诊断 Prompt 优化**：替换为完整的 AgentTeams SRE 专家故障排查模板，覆盖 7 步分析流程（提炼症状 → 日志扫描 → 时间线重建 → 关联上下文 → 假设验证 → 给出方案 → 缺失信息），12 种常见根因类型
- **SSE 解析修复**：修复 `collectSSE` 函数无法正确解析 `event:` 字段导致所有事件被识别为 `data` 的 bug，进度条现在能实时更新（0%→95%→完成）
- **诊断页面精简**：移除已删除路由导致的 404（`/api/agentteams/troubleshoot`），移除基础设施详情大 Card 和健康检查独立 Card，聚焦核心诊断能力

### Bug Fixes

- 修复问天 AI 诊断 404 错误（troubleshoot 路由已删除，改为复用 `wen-tian/logs` SSE 端点）
- 修复日志分析进度条永远停在 0% 的问题（SSE event 字段未正确解析）
- 修复日志分析完成后结果不显示的问题（running 与结果显示互斥逻辑错误）

### Version Updates

- 默认镜像版本从 `v1.2.2` 更新至 `v1.2.3`
