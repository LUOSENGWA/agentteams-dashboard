'use client';

// 知识库 v2（workbench 插件同款数据面，9/16 装验定案「照插件做」）。
//   · 数据面：/api/agentteams/workers/[name]/workspace-files/{tree|file-metadata|file-content}
//     后端=Controller Docker 代理 tarball 只读（route.ts 内注释；旧 Controller 即开即用，
//     不再依赖 #1208 端点）——404=真实故障（容器/工作区缺失），直接显示服务端错误。
//   · KB 布局（插件四分类）：档案=顶层 md / 文件=其余顶层条目（只列不展开）/
//     日记=memory/** / 知识库=digest/**（懒展开：展开仅 memory/**·digest/**）
//   · 选择器：团队透传（optgroup 按 team 分组 + 负责人标记）
//   · 图谱：wikilink 2D 力导向（[[title]] 从 md 内容客户端解析，无新上游依赖；
//     dashboard 不引 three.js——深交互留给插件宿主版，本处=简化渲染+点节点开预览）
//   · 预览：file-content 分块读（offset/eof 循环；v2 后端单块 ≤1MB 即 eof）

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  FileText,
  FolderOpen,
  Folder,
  Loader2,
  Network,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/dashboard/section-header';
import { MarkdownMessage } from '@/components/dashboard/sections/chat/markdown-message';
import { useWorkers } from '@/hooks/use-agentteams-workers';
import type { WorkerResponse } from '@/lib/agentteams-api';

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

interface GNode { id: string; path: string; label: string; deg: number; isMemory: boolean }
interface GEdge { s: number; t: number }

const base = (w: string) => `/api/agentteams/workers/${encodeURIComponent(w)}/workspace-files`;
const MAX_GRAPH_FILES = 60; // 图谱内容抓取上限（防大 KB 拖死）
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
    // 斥力（O(n²)，n≤60 可接受）
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

// ── 图谱子组件 ─────────────────────────────────────────────────────────────
function KnowledgeGraph({
  nodes,
  edges,
  positions,
  onSelect,
}: {
  nodes: GNode[];
  edges: GEdge[];
  positions: { x: number; y: number }[];
  onSelect: (_path: string) => void;
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
  if (nodes.length === 0) {
    return <p className="p-4 text-xs text-muted-foreground">该 Worker 暂无知识库文件（MEMORY.md/memory/digest）。</p>;
  }
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
          onClick={() => onSelect(node.path)}
        >
          <circle
            r={hover === i ? Math.min(15, 6 + node.deg * 1.2) : Math.min(13, 5 + node.deg)}
            fill={node.isMemory ? '#f59e0b' : '#6366f1'}
            fillOpacity={hover == null || adjacent.has(i) ? 0.75 : 0.25}
            stroke={node.isMemory ? '#b45309' : '#4338ca'}
          />
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
        </g>
      ))}
    </svg>
  );
}

// ── 主 section ─────────────────────────────────────────────────────────────
export function KnowledgeSection() {
  const { data: workers } = useWorkers();
  const [worker, setWorker] = useState('');
  const effectiveWorker = worker || workers?.[0]?.name || '';

  const [topEntries, setTopEntries] = useState<TreeEntry[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graph, setGraph] = useState<{ nodes: GNode[]; edges: GEdge[]; positions: { x: number; y: number }[] } | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, TreeEntry[]>>({});
  const [treeDirsLoading, setTreeDirsLoading] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<'graph' | 'files'>('graph');
  const genRef = useRef(0);

  const loadGraph = useCallback(async (w: string) => {
    const gen = ++genRef.current;
    setGraphLoading(true);
    setGraph(null);
    try {
      const files = await collectMdFiles(w);
      if (gen !== genRef.current) return;
      // MEMORY.md 若在（KB 布局根文件）优先入图
      const hasMemory = files.includes('MEMORY.md');
      const targets = files.filter((f) => f !== 'MEMORY.md').slice(0, MAX_GRAPH_FILES - 1);
      const all = hasMemory ? ['MEMORY.md', ...targets] : files.slice(0, MAX_GRAPH_FILES);
      const contents: (string | null)[] = new Array(all.length).fill(null);
      let idx = 0;
      const concurrency = 6;
      const workerPool = async () => {
        while (idx < all.length) {
          const i = idx;
          idx += 1;
          try {
            contents[i] = await fetchFullContent(w, all[i]);
          } catch {
            contents[i] = null;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, all.length) }, () => workerPool()));
      if (gen !== genRef.current) return;
      // 建图：节点=文件（id=文件名干），边=wikilink 目标按文件名干匹配
      const nodes: GNode[] = all.map((p) => ({
        id: stem(p),
        path: p,
        label: stem(p),
        deg: 0,
        isMemory: p === 'MEMORY.md',
      }));
      // 键小写化：wikilink [[MEMORY]] 须匹配节点干 'MEMORY'（target 统一 toLowerCase 查）
      const idIndex = new Map(nodes.map((nd, i) => [nd.id.toLowerCase(), i]));
      const edges: GEdge[] = [];
      const seen = new Set<string>();
      all.forEach((p, i) => {
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
      const positions = forceLayout(nodes, edges);
      setGraph({ nodes, edges, positions });
    } catch (err) {
      if (gen === genRef.current) setLoadError(err instanceof Error ? err.message : '加载失败');
    } finally {
      if (gen === genRef.current) setGraphLoading(false);
    }
  }, []);

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
      setPreviewPath(null);
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

  const openPreview = useCallback(async (path: string) => {
    setView('files');
    setPreviewPath(path);
    setPreviewText('');
    setPreviewError('');
    setPreviewLoading(true);
    try {
      setPreviewText(await fetchFullContent(effectiveWorker, path));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : '读取失败');
    } finally {
      setPreviewLoading(false);
    }
  }, [effectiveWorker]);

  // 团队透传：worker 选择器按 team 分组（optgroup），负责人标记
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

  return (
    <div className="space-y-4 p-4">
      <SectionHeader
        title="知识库"
        description="集群 Worker 记忆只读视图（workbench 插件同款数据面：Controller Docker 代理）：档案 / 文件 / 日记 memory/** / 知识库 digest/** + wikilink 图谱"
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
              disabled={loading || graphLoading}
              onClick={() => effectiveWorker && void reload(effectiveWorker)}
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
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* 左：KB 文件树 */}
          <div className="rounded-md border border-border/60 p-2">
            <div className="mb-2 flex items-center gap-2">
              <Button
                variant={view === 'files' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setView('files')}
              >
                <FolderOpen className="mr-1 h-3 w-3" aria-hidden="true" />
                文件
              </Button>
              <Button
                variant={view === 'graph' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setView('graph')}
              >
                <Network className="mr-1 h-3 w-3" aria-hidden="true" />
                图谱
              </Button>
              <span className="ml-auto text-[10px] text-muted-foreground">{effectiveWorker || '—'}</span>
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
                    <FileRow key={e.path} entry={e} onFile={openPreview} />
                  ))}
                  {groups.archive.length === 0 && (
                    <p className="px-4 py-0.5 text-[10px] text-muted-foreground/70">（无顶层 md）</p>
                  )}
                  <GroupLabel text="文件" />
                  {groups.files.map((e) => (
                    <FileRow key={e.path} entry={e} onFile={openPreview} />
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
                          <TreeRow key={e.path} entry={e} depth={1} onFile={openPreview} onDir={(dir) => void loadDir(dir)} loading={treeDirsLoading} expandedMap={expanded} setExpanded={setExpanded} />
                        ))}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* 右：图谱 / 预览 */}
          <div className="flex min-h-[420px] flex-col rounded-md border border-border/60">
            {view === 'graph' ? (
              graphLoading || loading ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  构建 wikilink 图谱（抓取 ≤{MAX_GRAPH_FILES} 个 md 文件）…
                </div>
              ) : graph ? (
                <KnowledgeGraph nodes={graph.nodes} edges={graph.edges} positions={graph.positions} onSelect={(p) => void openPreview(p)} />
              ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  {graphLoading ? '加载中…' : '点「刷新」加载图谱'}
                </div>
              )
            ) : previewPath ? (
              <div className="flex flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setPreviewPath(null)}>
                    <ArrowLeft className="mr-1 h-3 w-3" aria-hidden="true" />
                    返回
                  </Button>
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="text-xs font-medium">{previewPath}</span>
                </div>
                <div className="flex-1 overflow-auto p-4">
                  {previewLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      读取中（分块 ≤{MAX_CHUNKS * CHUNK / 1024}KB）…
                    </div>
                  ) : previewError ? (
                    <p className="text-xs text-red-600">{previewError}</p>
                  ) : previewPath.toLowerCase().endsWith('.md') ? (
                    <MarkdownMessage content={previewText} />
                  ) : (
                    <pre className="whitespace-pre-wrap text-xs">{previewText}</pre>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                左侧点文件查看内容，或切「图谱」看 wikilink 引用网络
              </div>
            )}
          </div>
        </div>
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
