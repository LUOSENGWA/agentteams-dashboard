'use client';

// 知识库 v3（9/17 装验定案「照插件做」三件：3D / 预览与图谱分离 /
// 团队聚合图谱——workbench 插件 KnowledgeBase.tsx 同款结构）。
//   · 数据面（v2 不变）：/api/agentteams/workers/[name]/workspace-files/{tree|file-metadata|file-content}
//     后端=Controller Docker 代理 tarball 只读（route.ts 内注释）——
//     404=真实故障（容器/工作区缺失），直接显示服务端错误。
//   · 布局（插件同构）：左=KB 文件树（四分类）；右=**图谱卡常驻** +
//     **预览卡独立下置**——点节点/文件只更新预览卡，图谱永不消失
//     （修「点开预览再点回退退到空白」：单格视图互斥 → 双视图并存）。
//   · 图谱：2D/3D 双引擎（**默认 3D**，偏好持久化；3D=knowledge-graph3d.tsx
//     插件 Graph3D 移植，3d-force-graph+three；WebGL 不可用/初始化失败→
//     降级提示 + 一键回 2D，图谱不炸 tab）。
//   · 团队聚合图谱（插件 fetchKbGraphMerged 的客户端等价物——dashboard
//     无插件同款服务端合并端点，改客户端按团队拉各 Worker md 合并建图）：
//     节点按 Worker 着色（AGENT_PALETTE 插件同值）、id=`worker::path`、
//     边保留各 Worker 内部；点聚合节点开**目标 Worker** 文件，不切换
//     当前 Worker（插件 agentOverride 同语义）。
//   · 选择记忆（插件 kbState 同款）：worker / graphMode / team / 3D-2D
//     偏好 localStorage 持久化，失效值回退默认。
//   · 预览：file-content 分块读（offset/eof 循环；v2 后端单块 ≤1MB 即 eof）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  FileText,
  FolderOpen,
  Folder,
  Loader2,
  Network,
  RefreshCw,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/dashboard/section-header';
import { MarkdownMessage } from '@/components/dashboard/sections/chat/markdown-message';
import { useWorkers } from '@/hooks/use-agentteams-workers';
import type { WorkerResponse } from '@/lib/agentteams-api';
import KnowledgeGraph3D, { type G3DNodeInput } from '@/components/dashboard/knowledge-graph3d';

// ── 类型（#1208 D2 / QwenPaw workspace_files.py 实锤形状）──────────────────
interface TreeEntry {
  kind: 'file' | 'directory';
  name: string;
  path: string;
  size: number | null;
  modified_at: string;
  preview_kind: string;
}
interface TreeResponse {
  directory: string;
  entries: TreeEntry[];
  has_more: boolean;
  next_cursor: string | null;
}
interface FileContentResponse {
  content: string;
  eof: boolean;
  offset: number;
  next_offset: number;
  etag: string;
}

// v3：节点 id=**文件路径**（干名只做 wikilink 匹配键——同干不同目录
// 两文件不再被合并成一个节点；插件单 Agent 图 id=path 同款）。
interface GNode {
  id: string;
  path: string;
  label: string;
  deg: number;
  isMemory: boolean;
  /** 聚合模式：节点所属 Worker（着色/跳转用）。 */
  agent?: string;
}
interface GEdge { s: number; t: number }
interface GraphData { nodes: GNode[]; edges: GEdge[]; positions: { x: number; y: number }[] }

// 聚合节点图例配色（插件 AGENT_PALETTE 同值）。
const AGENT_PALETTE = [
  '#FF7F16', '#1677ff', '#52c41a', '#f5222d', '#722ed1',
  '#fa8c16', '#13c2c2', '#eb2f96',
];

// 选择记忆键（插件 kbState 同款语义：存值、失效回退默认）。
const KB_MEM = 'agentteams:kb:';
function readMem(key: string): string {
  try { return window.localStorage.getItem(KB_MEM + key) ?? ''; } catch { return ''; }
}
function writeMem(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(KB_MEM + key, value);
    else window.localStorage.removeItem(KB_MEM + key);
  } catch { /* 存储不可用（隐私模式）=不记忆，不报错 */ }
}

const base = (w: string) => `/api/agentteams/workers/${encodeURIComponent(w)}/workspace-files`;
const MAX_GRAPH_FILES = 60; // 单 Worker 图谱内容抓取上限（防大 KB 拖死）
const MAX_MERGED_FILES = 240; // 聚合模式全量上限（跨 Worker 总预算）
const CHUNK = 200_000; // file-content 单块
const MAX_CHUNKS = 8; // 单文件最多 1.6MB

// ── 数据获取 ───────────────────────────────────────────────────────────────
/** 服务端错误消息提取（v2：404=真实故障，消息来自 route.ts）。 */
async function httpError(res: Response, what: string): Promise<Error> {
  let msg = `${what} → HTTP ${res.status}`;
  try {
    const b = (await res.json()) as { error?: string };
    if (b?.error) msg = b.error;
  } catch { /* 非 JSON 错误体，保留状态码消息 */ }
  return new Error(msg);
}

async function fetchTree(worker: string, dir: string): Promise<TreeEntry[]> {
  let cursor: string | null = null;
  const out: TreeEntry[] = [];
  for (let page = 0; page < 5; page += 1) {
    const qs = new URLSearchParams({ path: dir });
    if (cursor) qs.set('cursor', cursor);
    const res = await fetch(`${base(worker)}/tree?${qs.toString()}`, { cache: 'no-store' });
    if (!res.ok) throw await httpError(res, `tree ${dir}`);
    const body = (await res.json()) as TreeResponse;
    out.push(...(body.entries ?? []));
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return out;
}

async function fetchFullContent(worker: string, path: string, cap = MAX_CHUNKS): Promise<string> {
  let offset = 0;
  let out = '';
  for (let i = 0; i < cap; i += 1) {
    const qs = new URLSearchParams({ path, offset: String(offset), limit: String(CHUNK) });
    const res = await fetch(`${base(worker)}/file-content?${qs.toString()}`, { cache: 'no-store' });
    if (!res.ok) throw await httpError(res, `file-content ${path}`);
    const body = (await res.json()) as FileContentResponse;
    out += body.content ?? '';
    if (body.eof) return out;
    offset = body.next_offset;
    if (!Number.isFinite(offset) || offset <= 0) return out;
  }
  return out;
}

/** 收集 KB 内全部 md 文件（顶层档案 md + memory/** + digest/**，深度≤4） */
async function collectMdFiles(worker: string): Promise<string[]> {
  const top = await fetchTree(worker, ''); // 顶层失败=致命（工作区不可达）
  const files: string[] = top
    .filter((e) => e.kind === 'file' && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.path);
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries: TreeEntry[];
    try {
      entries = await fetchTree(worker, dir);
    } catch {
      return; // 单目录失败不拖垮全量
    }
    for (const e of entries) {
      if (e.kind === 'directory') await walk(e.path, depth + 1);
      else if (e.name.toLowerCase().endsWith('.md')) files.push(e.path);
    }
  };
  await Promise.all([walk('memory', 1), walk('digest', 1)]);
  // 去重（顶层档案与子树不重叠，此处仅防重复）
  return Array.from(new Set(files));
}

/** wikilink [[title]] / [[title|alias]] / [[title#anchor]] → title */
function extractWikilinks(md: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|\[\n]+?)(?:#[^\]|\[\n]*)?(?:\|[^\]\n]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

const basename = (p: string) => p.split('/').pop() ?? p;
const stem = (p: string) => (basename(p).toLowerCase().endsWith('.md') ? basename(p).slice(0, -3) : basename(p));

/** 单 Worker 建图（单 Agent 模式与聚合模式每 Worker 共用）：
 *  节点=md 文件（id=路径 / label=干名），边=wikilink 按干名匹配（文件内索引）。 */
async function buildAgentGraph(worker: string, cap: number): Promise<{ nodes: Omit<GNode, 'agent'>[]; edges: GEdge[] }> {
  const files = await collectMdFiles(worker);
  // MEMORY.md 若在（KB 布局根文件）优先入图
  const hasMemory = files.includes('MEMORY.md');
  const targets = files.filter((f) => f !== 'MEMORY.md').slice(0, cap - 1);
  const all = hasMemory ? ['MEMORY.md', ...targets] : files.slice(0, cap);
  const contents: (string | null)[] = new Array(all.length).fill(null);
  let idx = 0;
  const concurrency = 6;
  const workerPool = async () => {
    while (idx < all.length) {
      const i = idx;
      idx += 1;
      try {
        contents[i] = await fetchFullContent(worker, all[i]);
      } catch {
        contents[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, all.length)) }, () => workerPool()));
  const nodes: Omit<GNode, 'agent'>[] = all.map((p) => ({
    id: p,
    path: p,
    label: stem(p),
    deg: 0,
    isMemory: p === 'MEMORY.md',
  }));
  // 键小写化：wikilink [[MEMORY]] 须匹配节点干 'MEMORY'（target 统一 toLowerCase 查）
  const idIndex = new Map<string, number>();
  nodes.forEach((nd, i) => {
    const k = nd.label.toLowerCase();
    if (!idIndex.has(k)) idIndex.set(k, i); // 同干多文件=首个（与 v2 一致，label 冲突时边归属首见）
  });
  const edges: GEdge[] = [];
  const seen = new Set<string>();
  all.forEach((_p, i) => {
    const links = contents[i] ? extractWikilinks(contents[i]) : [];
    for (const t of links) {
      const ti = idIndex.get(t.toLowerCase());
      if (ti != null && ti !== i) {
        const key = `${i}-${ti}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ s: i, t: ti });
          nodes[i].deg += 1;
          nodes[ti].deg += 1;
        }
      }
    }
  });
  return { nodes, edges };
}

// ── 2D 力导向布局（确定性：初值=圆环按序，迭代纯函数——无 Math.random）──────
function forceLayout(nodes: GNode[], edges: GEdge[], w = 760, h = 420): { x: number; y: number }[] {
  const n = nodes.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const R = Math.min(w, h) * 0.36;
  for (let i = 0; i < n; i += 1) {
    const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
    px[i] = w / 2 + Math.cos(a) * R;
    py[i] = h / 2 + Math.sin(a) * R * 0.62;
  }
  const REST = 92;
  const REP = 2600;
  for (let tick = 0; tick < 140; tick += 1) {
    // 斥力（O(n²)，n≤240 可接受）
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = px[i] - px[j];
        let dy = py[i] - py[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02; }
        const d = Math.sqrt(d2);
        const f = Math.min(24, REP / d2);
        dx /= d; dy /= d;
        vx[i] += dx * f; vy[i] += dy * f;
        vx[j] -= dx * f; vy[j] -= dy * f;
      }
    }
    // 弹簧
    for (const e of edges) {
      const dx = px[e.t] - px[e.s];
      const dy = py[e.t] - py[e.s];
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - REST) * 0.02;
      vx[e.s] += (dx / d) * f; vy[e.s] += (dy / d) * f;
      vx[e.t] -= (dx / d) * f; vy[e.t] -= (dy / d) * f;
    }
    // 向心 + 阻尼 + 限步
    for (let i = 0; i < n; i += 1) {
      vx[i] += (w / 2 - px[i]) * 0.004;
      vy[i] += (h / 2 - py[i]) * 0.004;
      vx[i] *= 0.82; vy[i] *= 0.82;
      const sp = Math.hypot(vx[i], vy[i]);
      if (sp > 7) { vx[i] = (vx[i] / sp) * 7; vy[i] = (vy[i] / sp) * 7; }
      px[i] = Math.max(24, Math.min(w - 24, px[i] + vx[i]));
      py[i] = Math.max(20, Math.min(h - 16, py[i] + vy[i]));
    }
  }
  return Array.from({ length: n }, (_, i) => ({ x: px[i], y: py[i] }));
}

// ── 2D 图谱子组件 ──────────────────────────────────────────────────────────
function KnowledgeGraph({
  nodes,
  edges,
  positions,
  onSelect,
  agentPalette,
}: {
  nodes: GNode[];
  edges: GEdge[];
  positions: { x: number; y: number }[];
  onSelect: (_path: string, _agent?: string) => void;
  /** 聚合模式：按 Worker 着色（插件 agentLegend 同款）。 */
  agentPalette?: { name: string; color: string }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760;
  const H = 420;
  const adjacent = useMemo(() => {
    const set = new Set<number>();
    if (hover != null) {
      set.add(hover);
      edges.forEach((e, i) => {
        if (e.s === hover || e.t === hover) { set.add(i); }
      });
    }
    return set;
  }, [hover, edges]);
  // 聚合模式节点多（≤240）：标签只给悬停/选中 + 度数 top14（插件 labeledIds 同规则）
  const labeledIds = useMemo(() => {
    if (!agentPalette) return null;
    const s = new Set<number>();
    [...nodes.keys()].sort((a, b) => (nodes[b]?.deg ?? 0) - (nodes[a]?.deg ?? 0)).slice(0, 14).forEach((i) => s.add(i));
    return s;
  }, [nodes, agentPalette]);
  if (nodes.length === 0) {
    return <p className="p-4 text-xs text-muted-foreground">该 Worker 暂无知识库文件（MEMORY.md/memory/digest）。</p>;
  }
  const colorOf = (i: number): string => {
    const node = nodes[i];
    if (agentPalette && node.agent) {
      return agentPalette.find((l) => l.name === node.agent)?.color ?? '#8c8c8c';
    }
    return node.isMemory ? '#f59e0b' : '#6366f1';
  };
  const strokeOf = (i: number): string => {
    if (agentPalette && nodes[i].agent) return 'rgba(0,0,0,0.25)';
    return nodes[i].isMemory ? '#b45309' : '#4338ca';
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="img" aria-label="知识库 wikilink 图谱">
      {edges.map((e, i) => (
        <line
          key={i}
          x1={positions[e.s].x}
          y1={positions[e.s].y}
          x2={positions[e.t].x}
          y2={positions[e.t].y}
          stroke={hover != null && adjacent.has(i) ? '#f59e0b' : '#94a3b8'}
          strokeOpacity={hover == null ? 0.3 : adjacent.has(i) ? 0.85 : 0.08}
          strokeWidth={hover != null && adjacent.has(i) ? 1.6 : 1}
        />
      ))}
      {nodes.map((node, i) => (
        <g
          key={node.id}
          transform={`translate(${positions[i].x}, ${positions[i].y})`}
          className="cursor-pointer"
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
          onClick={() => onSelect(node.path, node.agent)}
        >
          <circle
            r={hover === i ? Math.min(15, 6 + node.deg * 1.2) : Math.min(13, 5 + node.deg)}
            fill={colorOf(i)}
            fillOpacity={hover == null || adjacent.has(i) ? 0.75 : 0.25}
            stroke={strokeOf(i)}
          />
          {(!agentPalette || hover === i || (labeledIds?.has(i) ?? false)) && (
            <text
              y={-Math.min(13, 5 + node.deg) - 4}
              textAnchor="middle"
              className="select-none"
              fontSize="10"
              fill="currentColor"
              opacity={hover == null || adjacent.has(i) ? 0.85 : 0.3}
            >
              {node.label.length > 14 ? `${node.label.slice(0, 14)}…` : node.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ── 主 section ─────────────────────────────────────────────────────────────
export function KnowledgeSection() {
  const { data: workers } = useWorkers();
  const [worker, setWorker] = useState('');
  // 默认 worker 漂移修复（9/16 真机 E2E 实锤）：Controller /api/v1/workers
  // 列表顺序不稳定（k8s list 序），未手动选择时每轮轮询跟 workers[0] 走会
  // 让整个视图静默重置换人（已展开的目录被清掉）。按任务看板同款「推导
  // 选中、不同步状态」惯例（tasks-section effectiveProjectId）：对列表做
  // 确定序（按名）推导默认，跨轮询稳定；用户手动选择后以选择为准。
  const sortedWorkers = useMemo(
    () =>
      [...(workers ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      ),
    [workers],
  );
  const effectiveWorker = worker || sortedWorkers[0]?.name || '';

  // 选择记忆（插件 kbState 同款）：worker 列表落地后校验有效性再恢复
  // （失效值回退默认推导，不闪错人）。
  useEffect(() => {
    if (worker || sortedWorkers.length === 0) return;
    const saved = readMem('worker');
    if (saved && sortedWorkers.some((w) => w.name === saved)) {
      const t = setTimeout(() => setWorker(saved), 0);
      return () => clearTimeout(t);
    }
  }, [worker, sortedWorkers]);
  useEffect(() => { writeMem('worker', worker); }, [worker]);

  // 图谱模式 / 聚合团队 / 3D-2D 偏好（持久化）
  const [graphMode, setGraphMode] = useState<'worker' | 'merged'>(
    () => (readMem('graph-mode') === 'merged' ? 'merged' : 'worker'),
  );
  const [kbTeam, setKbTeam] = useState(''); // ''=全部团队
  const [viewMode, setViewMode] = useState<'3d' | '2d'>(
    () => (readMem('view-mode') === '2d' ? '2d' : '3d'),
  );
  const [graphVisible, setGraphVisible] = useState(true);
  const [selectedId3d, setSelectedId3d] = useState('');
  useEffect(() => { writeMem('graph-mode', graphMode === 'worker' ? '' : 'merged'); }, [graphMode]);
  useEffect(() => { writeMem('view-mode', viewMode === '3d' ? '' : '2d'); }, [viewMode]);

  const [topEntries, setTopEntries] = useState<TreeEntry[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [mergedGraph, setMergedGraph] = useState<GraphData | null>(null);
  const [mergedLoading, setMergedLoading] = useState(false);
  // 预览（v3：独立卡状态——{path, worker}，worker 可≠当前 Worker=聚合跨 Worker 打开）
  const [preview, setPreview] = useState<{ path: string; worker: string } | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, TreeEntry[]>>({});
  const [treeDirsLoading, setTreeDirsLoading] = useState<Record<string, boolean>>({});
  const genRef = useRef(0);
  const mergedGenRef = useRef(0);

  // 团队透传：worker 选择器按 team 分组（optgroup），负责人标记
  // （loadMerged 聚合范围依赖此表，须先定义）
  const teamGroups = useMemo(() => {
    const list: WorkerResponse[] = workers ?? [];
    const map = new Map<string, WorkerResponse[]>();
    for (const wd of list) {
      const team = wd.team || '';
      if (!map.has(team)) map.set(team, []);
      map.get(team)!.push(wd);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => (a === b ? 0 : a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([team, list]) => ({
        team,
        workers: [...list].sort((x, y) => x.name.localeCompare(y.name)),
      }));
  }, [workers]);

  // 聚合团队有效值（派生——团队消失时回退全部团队，不同步 setState）。
  // 必须先于 loadMerged 定义（其 useCallback 依赖数组在渲染期求值，
  // const 后置声明会触发 TDZ ReferenceError）。
  const effectiveKbTeam = kbTeam && teamGroups.some((g) => g.team === kbTeam) ? kbTeam : '';
  useEffect(() => { writeMem('team', effectiveKbTeam); }, [effectiveKbTeam]);

  const loadGraph = useCallback(async (w: string) => {
    const gen = ++genRef.current;
    setGraphLoading(true);
    setGraph(null);
    try {
      const ag = await buildAgentGraph(w, MAX_GRAPH_FILES);
      if (gen !== genRef.current) return;
      const positions = forceLayout(ag.nodes as GNode[], ag.edges);
      setGraph({ nodes: ag.nodes as GNode[], edges: ag.edges, positions });
    } catch (err) {
      if (gen === genRef.current) setLoadError(err instanceof Error ? err.message : '加载失败');
    } finally {
      if (gen === genRef.current) setGraphLoading(false);
    }
  }, []);

  // 团队聚合建图（客户端合并——插件 fetchKbGraphMerged 的等价物）：
  // 范围=effectiveKbTeam 团队成员（''=全部 Worker）；总预算 240 文件、单 Worker 60；
  // 节点 id 前缀 `worker::`，边保留各 Worker 内部（跨 Worker 无边=插件同款）。
  const loadMerged = useCallback(async () => {
    const gen = ++mergedGenRef.current;
    setMergedLoading(true);
    setMergedGraph(null);
    try {
      const scope = effectiveKbTeam
        ? teamGroups.find((g) => g.team === effectiveKbTeam)?.workers.map((wd) => wd.name) ?? []
        : sortedWorkers.map((wd) => wd.name);
      const nodes: GNode[] = [];
      const edges: GEdge[] = [];
      let budget = MAX_MERGED_FILES;
      for (const w of scope) {
        if (budget <= 0) break;
        const ag = await buildAgentGraph(w, Math.min(MAX_GRAPH_FILES, budget));
        budget -= ag.nodes.length;
        const offset = nodes.length;
        for (const n of ag.nodes) nodes.push({ ...n, id: `${w}::${n.id}`, agent: w });
        for (const e of ag.edges) edges.push({ s: e.s + offset, t: e.t + offset });
      }
      if (gen !== mergedGenRef.current) return;
      const positions = forceLayout(nodes, edges);
      setMergedGraph({ nodes, edges, positions });
    } catch {
      if (gen === mergedGenRef.current) setMergedGraph(null);
    } finally {
      if (gen === mergedGenRef.current) setMergedLoading(false);
    }
  }, [effectiveKbTeam, teamGroups, sortedWorkers]);

  // 聚合模式：切模式/切团队/团队列表变化 → 重拉（loadMerged 入口自带清旧图）
  useEffect(() => {
    if (graphMode !== 'merged') return;
    // 宏任务触发（同 reload effect 模式：effect 内不同步 setState 链）
    const t = setTimeout(() => { void loadMerged(); }, 0);
    return () => clearTimeout(t);
  }, [graphMode, effectiveKbTeam, teamGroups, loadMerged]);

  // 顶层文件树（四分类分组来源）+ 图谱，随 Worker 切换/刷新重载
  const reload = useCallback(async (w: string) => {
    setLoadError('');
    setTopEntries(null);
    setLoading(true);
    try {
      setTopEntries(await fetchTree(w, ''));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '文件树加载失败');
    } finally {
      setLoading(false);
    }
    void loadGraph(w);
  }, [loadGraph]);

  // 延迟一个宏任务（同 B5：避免 effect 同步阶段 setState 链）
  useEffect(() => {
    if (!effectiveWorker) return;
    const t = setTimeout(() => {
      setGraph(null);
      setExpanded({});
      setPreview(null);
      void reload(effectiveWorker);
    }, 0);
    return () => clearTimeout(t);
  }, [effectiveWorker, reload]);

  const loadDir = useCallback(async (dir: string) => {
    setTreeDirsLoading((m) => ({ ...m, [dir]: true }));
    try {
      const entries = await fetchTree(effectiveWorker, dir);
      setExpanded((m) => ({ ...m, [dir]: entries }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '目录加载失败');
    } finally {
      setTreeDirsLoading((m) => ({ ...m, [dir]: false }));
    }
  }, [effectiveWorker]);

  // 下载（对齐插件 KB 文件下载）：file-content?raw=1 原始字节 → blob → a[download]
  const downloadFile = useCallback(async (worker: string, path: string) => {
    try {
      const qs = new URLSearchParams({ path, raw: '1' });
      const res = await fetch(`${base(worker)}/file-content?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error || `下载失败（${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = basename(path);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : '下载失败');
    }
  }, []);

  // 打开预览（v3：agentOverride=聚合模式跨 Worker 打开目标文件，
  // **不切换当前 Worker**——插件 openFile(agentOverride) 同语义；
  // 图谱卡保持不动，只更新预览卡）。
  const openPreview = useCallback(async (path: string, agentOverride?: string) => {
    const w = agentOverride || effectiveWorker;
    setPreview({ path, worker: w });
    setPreviewText('');
    setPreviewError('');
    setPreviewLoading(true);
    try {
      setPreviewText(await fetchFullContent(w, path));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : '读取失败');
    } finally {
      setPreviewLoading(false);
    }
  }, [effectiveWorker]);

  // 四分类分组（插件同款）：档案=顶层 md / 文件=其余顶层（只列不展开）/ 日记 memory / 知识库 digest
  const groups = useMemo(() => {
    if (topEntries === null) return null;
    const isMd = (e: TreeEntry) => e.kind === 'file' && e.name.toLowerCase().endsWith('.md');
    return {
      archive: topEntries.filter(isMd),
      files: topEntries.filter((e) => e.kind === 'file' && !isMd(e)),
      topDirs: topEntries.filter((e) => e.kind === 'directory' && e.path !== 'memory' && e.path !== 'digest'),
      memory: topEntries.find((e) => e.kind === 'directory' && e.path === 'memory') ?? null,
      digest: topEntries.find((e) => e.kind === 'directory' && e.path === 'digest') ?? null,
    };
  }, [topEntries]);

  // 当前生效图（单 Agent / 聚合）
  const currentGraph = graphMode === 'merged' ? mergedGraph : graph;
  const currentLoading = graphMode === 'merged' ? mergedLoading : graphLoading;
  const mergedScopeCount = graphMode === 'merged'
    ? (effectiveKbTeam
        ? teamGroups.find((g) => g.team === effectiveKbTeam)?.workers.length ?? 0
        : sortedWorkers.length)
    : 0;

  // 聚合图例（节点按 Worker 着色，插件 AGENT_PALETTE 顺序=首次出现序）
  const agentLegend = useMemo(() => {
    if (graphMode !== 'merged' || !currentGraph) return null;
    const order: string[] = [];
    for (const n of currentGraph.nodes) {
      if (n.agent && !order.includes(n.agent)) order.push(n.agent);
    }
    if (order.length === 0) return null;
    return order.map((name, i) => ({ name, color: AGENT_PALETTE[i % AGENT_PALETTE.length] }));
  }, [graphMode, currentGraph]);

  // 3D 输入（插件 G3DNodeInput 同构：id/name/path/agent）
  const g3dNodes = useMemo<G3DNodeInput[]>(() => {
    if (!currentGraph) return [];
    return currentGraph.nodes.map((n) => ({
      id: n.id,
      name: n.label,
      path: n.path,
      agent: n.agent,
    }));
  }, [currentGraph]);
  const g3dLinks = useMemo(() => {
    if (!currentGraph) return [];
    return currentGraph.edges.map((e) => ({
      source: currentGraph.nodes[e.s].id,
      target: currentGraph.nodes[e.t].id,
    }));
  }, [currentGraph]);
  const colorFor3d = useCallback(
    (n: G3DNodeInput): string => {
      if (agentLegend && n.agent) {
        return agentLegend.find((l) => l.name === n.agent)?.color ?? '#8c8c8c';
      }
      return n.path === 'MEMORY.md' ? '#f59e0b' : '#6366f1';
    },
    [agentLegend],
  );

  // 3D 选中条（节点名 + 出/入链计数——插件 {panel} 的轻量版）
  const sel3d = useMemo(() => {
    if (!selectedId3d || !currentGraph) return null;
    const i = currentGraph.nodes.findIndex((n) => n.id === selectedId3d);
    if (i < 0) return null;
    let out = 0;
    let inn = 0;
    for (const e of currentGraph.edges) {
      if (e.s === i) out += 1;
      if (e.t === i) inn += 1;
    }
    return { node: currentGraph.nodes[i], out, inn };
  }, [selectedId3d, currentGraph]);

  // 3D 节点点击 → 开预览（聚合：`worker::path` 解析；单 Agent：path）
  const onOpenNode3d = useCallback(
    (n: G3DNodeInput) => {
      const sep = n.id.indexOf('::');
      if (graphMode === 'merged' && sep > 0) {
        void openPreview(n.id.slice(sep + 2), n.id.slice(0, sep));
        return;
      }
      if (n.path) void openPreview(n.path);
    },
    [graphMode, openPreview],
  );

  return (
    <div className="space-y-4 p-4">
      <SectionHeader
        title="知识库"
        description="集群 Worker 记忆只读视图（workbench 插件同款数据面：Controller Docker 代理）：档案 / 文件 / 日记 memory/** / 知识库 digest/** + wikilink 图谱（2D/3D · 团队聚合）"
        actions={
          <div className="flex items-center gap-2">
            <select
              className="h-8 max-w-[220px] rounded-md border bg-transparent px-2 text-xs"
              value={effectiveWorker}
              onChange={(e) => setWorker(e.target.value)}
              aria-label="选择 Worker（按团队分组）"
            >
              {teamGroups.length === 0 && <option value="">（无 Worker）</option>}
              {teamGroups.map((g) => (
                <optgroup key={g.team || 'ungrouped'} label={g.team || '未分组'}>
                  {g.workers.map((wd) => (
                    <option key={wd.name} value={wd.name}>
                      {wd.name}{/leader/i.test(wd.role || '') ? ' · 负责人' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={loading || graphLoading || mergedLoading}
              onClick={() => {
                if (!effectiveWorker) return;
                void reload(effectiveWorker);
                if (graphMode === 'merged') void loadMerged();
              }}
            >
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading || graphLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              刷新
            </Button>
          </div>
        }
        isRefreshing={loading || graphLoading}
      />

      {loadError ? (
        <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {loadError}
        </div>
      ) : (
        <>
          {/* 图谱模式行（插件同款：当前 Agent 图谱 | 团队聚合图谱 + 聚合团队选择） */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-0.5 rounded-md border border-border/60 bg-transparent p-0.5">
              <Button
                variant={graphMode === 'worker' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => { setSelectedId3d(''); setGraphMode('worker'); }}
              >
                当前 Worker 图谱
              </Button>
              <Button
                variant={graphMode === 'merged' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => { setSelectedId3d(''); setGraphMode('merged'); }}
              >
                <Users className="mr-1 h-3 w-3" aria-hidden="true" />
                团队聚合图谱
              </Button>
            </div>
            {graphMode === 'merged' && teamGroups.length > 0 && (
              <select
                className="h-8 rounded-md border bg-transparent px-2 text-xs"
                value={effectiveKbTeam}
                onChange={(e) => setKbTeam(e.target.value)}
                aria-label="聚合团队"
              >
                <option value="">全部团队（{sortedWorkers.length} Workers）</option>
                {teamGroups.map((g) => (
                  <option key={g.team} value={g.team}>
                    {g.team}（{g.workers.length}）
                  </option>
                ))}
              </select>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {graphMode === 'merged'
                ? `聚合 ${mergedScopeCount} 个 Worker`
                : effectiveWorker || '—'}
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            {/* 左：KB 文件树（四分类，常驻——图谱不再占用此格） */}
            <div className="rounded-md border border-border/60 p-2">
              <div className="mb-2 flex items-center gap-2">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="text-xs font-medium">知识文件</span>
                <span className="ml-auto truncate text-[10px] text-muted-foreground">{effectiveWorker || '—'}</span>
              </div>
              <div className="space-y-0.5">
                {groups === null ? (
                  <div className="flex items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    加载文件树…
                  </div>
                ) : (
                  <>
                    <GroupLabel text="档案" />
                    {groups.archive.map((e) => (
                      <FileRow key={e.path} entry={e} onFile={(p) => void openPreview(p)} />
                    ))}
                    {groups.archive.length === 0 && (
                      <p className="px-4 py-0.5 text-[10px] text-muted-foreground/70">（无顶层 md）</p>
                    )}
                    <GroupLabel text="文件" />
                    {groups.files.map((e) => (
                      <FileRow key={e.path} entry={e} onFile={(p) => void openPreview(p)} />
                    ))}
                    {groups.topDirs.map((e) => (
                      <DirRowReadOnly key={e.path} entry={e} />
                    ))}
                    {groups.files.length === 0 && groups.topDirs.length === 0 && (
                      <p className="px-4 py-0.5 text-[10px] text-muted-foreground/70">（无）</p>
                    )}
                    {(['memory', 'digest'] as const).map((d) => {
                      const root = d === 'memory' ? groups.memory : groups.digest;
                      if (!root) return null;
                      const entries = expanded[root.path];
                      const open = !!entries;
                      return (
                        <div key={root.path}>
                          <GroupLabel text={d === 'memory' ? '日记 memory' : '知识库 digest'} />
                          <button
                            type="button"
                            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-accent"
                            onClick={() => {
                              if (!open) void loadDir(root.path);
                              else setExpanded((m) => ({ ...m, [root.path]: [] }));
                            }}
                          >
                            {open
                              ? <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                              : <Folder className="h-3.5 w-3.5" aria-hidden="true" />}
                            <span className="truncate font-medium">{root.name}/</span>
                            {treeDirsLoading[root.path] && (
                              <Loader2 className="ml-auto h-3 w-3 animate-spin" aria-hidden="true" />
                            )}
                          </button>
                          {open && (entries ?? []).map((e) => (
                            <TreeRow key={e.path} entry={e} depth={1} onFile={(p) => void openPreview(p)} onDir={(dir) => void loadDir(dir)} loading={treeDirsLoading} expandedMap={expanded} setExpanded={setExpanded} />
                          ))}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>

            {/* 右：图谱卡（常驻）+ 预览卡（独立下置） */}
            <div className="min-w-0 space-y-4">
              {/* 图谱卡 */}
              <div className="rounded-md border border-border/60">
                <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
                  <Network className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="text-xs font-medium">知识图谱（wikilink 引用网络）</span>
                  {currentGraph && (
                    <span className="text-[10px] text-muted-foreground">
                      {currentGraph.nodes.length} 节点 · {currentGraph.edges.length} 边
                    </span>
                  )}
                  {agentLegend ? (
                    <span className="flex items-center gap-2">
                      {agentLegend.map((l) => (
                        <span key={l.name} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
                          {l.name}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">→ 引用方向</span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <div className="flex gap-0.5 rounded-md border border-border/60 p-0.5">
                      <Button
                        variant={viewMode === '3d' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => setViewMode('3d')}
                      >
                        3D
                      </Button>
                      <Button
                        variant={viewMode === '2d' ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => setViewMode('2d')}
                      >
                        2D
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setGraphVisible((v) => !v)}
                    >
                      {graphVisible ? '收起' : '展开'}
                    </Button>
                  </div>
                </div>
                {graphVisible && (
                  <div className="p-3">
                    {currentLoading ? (
                      <div className="flex h-[280px] items-center justify-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {graphMode === 'merged'
                          ? `构建团队聚合图谱（${mergedScopeCount} 个 Worker，抓取 ≤${MAX_MERGED_FILES} 个 md 文件）…`
                          : `构建 wikilink 图谱（抓取 ≤${MAX_GRAPH_FILES} 个 md 文件）…`}
                      </div>
                    ) : !currentGraph || currentGraph.nodes.length === 0 ? (
                      <div className="flex h-[280px] items-center justify-center text-xs text-muted-foreground">
                        {graphMode === 'merged' ? '团队内暂无知识库文件' : '点「刷新」加载图谱'}
                      </div>
                    ) : viewMode === '3d' ? (
                      <>
                        <KnowledgeGraph3D
                          nodes={g3dNodes}
                          links={g3dLinks}
                          colorFor={colorFor3d}
                          isRoot={() => false}
                          isDirect={() => false}
                          onOpenNode={onOpenNode3d}
                          onSelect={setSelectedId3d}
                          onExit3D={() => setViewMode('2d')}
                          height={480}
                        />
                        {sel3d && (
                          <div className="mt-1 px-1 text-[11px] text-muted-foreground">
                            选中：<span className="font-medium text-foreground">{sel3d.node.label}</span>
                            {sel3d.node.agent && (
                              <span className="ml-1 font-mono text-[10px]">{sel3d.node.agent}</span>
                            )}
                            <span className="ml-2">出链 {sel3d.out} · 入链 {sel3d.inn}</span>
                            <span className="ml-2">点节点打开预览 · 点空白取消选中</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="h-[420px]">
                        <KnowledgeGraph
                          nodes={currentGraph.nodes}
                          edges={currentGraph.edges}
                          positions={currentGraph.positions}
                          onSelect={(p, agent) => void openPreview(p, agent)}
                          agentPalette={agentLegend ?? undefined}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 预览卡（独立——图谱卡永不消失；点节点/文件只更新此卡） */}
              <div className="flex min-h-[140px] flex-col rounded-md border border-border/60">
                <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate text-xs font-medium">{preview ? preview.path : '预览'}</span>
                  {preview && preview.worker !== effectiveWorker && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {preview.worker}
                    </span>
                  )}
                  {preview && !previewLoading && !previewError && previewText && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-1.5 text-xs"
                      onClick={() => void downloadFile(preview.worker, preview.path)}
                    >
                      <Download className="mr-1 h-3 w-3" aria-hidden="true" />
                      下载
                    </Button>
                  )}
                </div>
                <div className="max-h-[560px] flex-1 overflow-auto p-4">
                  {!preview ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      点击左侧文件查看内容，或点图谱节点直接打开（预览与图谱相互独立）
                    </p>
                  ) : previewLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      读取中（分块 ≤{MAX_CHUNKS * CHUNK / 1024}KB）…
                    </div>
                  ) : previewError ? (
                    <p className="text-xs text-red-600">{previewError}</p>
                  ) : previewText ? (
                    preview.path.toLowerCase().endsWith('.md') ? (
                      <MarkdownMessage content={previewText} />
                    ) : (
                      <pre className="whitespace-pre-wrap text-xs">{previewText}</pre>
                    )
                  ) : (
                    <p className="py-4 text-center text-xs text-muted-foreground">（空文件）</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function GroupLabel({ text }: { text: string }) {
  return (
    <p className="px-1.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {text}
    </p>
  );
}

function FileRow({ entry, onFile }: { entry: TreeEntry; onFile: (_p: string) => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-xs hover:bg-accent"
      style={{ paddingLeft: '22px' }}
      onClick={() => onFile(entry.path)}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

/** 顶层目录：只列不展开（插件同款——展开仅限 memory/** 与 digest/**）。 */
function DirRowReadOnly({ entry }: { entry: TreeEntry }) {
  return (
    <div
      className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground"
      style={{ paddingLeft: '22px' }}
      title="顶层目录只列不展开"
    >
      <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{entry.name}/</span>
    </div>
  );
}

function TreeRow({
  entry,
  depth,
  onFile,
  onDir,
  loading,
  expandedMap,
  setExpanded,
}: {
  entry: TreeEntry;
  depth: number;
  onFile: (_path: string) => void;
  onDir: (_dir: string) => void;
  loading: Record<string, boolean>;
  expandedMap: Record<string, TreeEntry[]>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, TreeEntry[]>>>;
}) {
  const entries = expandedMap[entry.path];
  const open = !!entries && entries.length > 0;
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-xs hover:bg-accent"
        style={{ paddingLeft: `${(depth + 1) * 10}px` }}
        onClick={() => {
          if (entry.kind === 'file') onFile(entry.path);
          else if (!open) onDir(entry.path);
          else setExpanded((m) => ({ ...m, [entry.path]: [] }));
        }}
      >
        {entry.kind === 'directory'
          ? (open ? <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />)
          : <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <span className="truncate">{entry.name}</span>
        {entry.kind === 'directory' && loading[entry.path] && (
          <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
        )}
      </button>
      {open && (entries ?? []).map((e) => (
        <TreeRow
          key={e.path}
          entry={e}
          depth={depth + 1}
          onFile={onFile}
          onDir={onDir}
          loading={loading}
          expandedMap={expandedMap}
          setExpanded={setExpanded}
        />
      ))}
    </div>
  );
}
