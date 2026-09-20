'use client';

// B7 知识库（#1208 workspace-files 消费）。形态=8/17 对接方案 3.3 定案：
//   · 数据面：/api/agentteams/workers/[name]/workspace-files/{tree|file-metadata|file-content}
//     KB 布局固定三根：MEMORY.md（根文件）/ memory/** / digest/**——
//     Controller D3 生死线禁 path="" 根列表，故不探根、按固定布局懒展开
//   · 图谱：wikilink 2D 力导向（[[title]] 从 md 内容客户端解析，无新上游依赖；
//     dashboard 不引 three.js——深交互留给插件宿主版，本处=简化渲染+点节点开预览）
//   · 预览：file-content 分块读（offset/eof 循环）→ md 走 MarkdownMessage
// 降级：#1208 未合并 → 上游 404 → 占位横幅（同 B4/B5 先例）。

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

/** Controller 错误体 → 可读文案（{message}/{error} 优先，解析失败退回状态码）。 */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    if (typeof body?.message === 'string' && body.message) return body.message;
    if (typeof body?.error === 'string' && body.error) return body.error;
  } catch {
    // 非 JSON 错误体；保留状态码
  }
  return `HTTP ${res.status}`;
}

// ── 数据获取 ───────────────────────────────────────────────────────────────
async function fetchTree(worker: string, dir: string): Promise<TreeEntry[] | null> {
  let cursor: string | null = null;
  const out: TreeEntry[] = [];
  for (let page = 0; page < 5; page += 1) {
    const qs = new URLSearchParams({ path: dir });
    if (cursor) qs.set('cursor', cursor);
    const res = await fetch(`${base(worker)}/tree?${qs.toString()}`, { cache: 'no-store' });
    if (res.status === 404) return null; // #1208 未合并（版本门/未部署）
    if (!res.ok) throw new Error(`tree ${dir} → ${await errorMessage(res)}`);
    const body = (await res.json()) as TreeResponse;
    out.push(...(body.entries ?? []));
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return out;
}

async function fetchFullContent(worker: string, path: string, cap = MAX_CHUNKS): Promise<string | null> {
  let offset = 0;
  let out = '';
  for (let i = 0; i < cap; i += 1) {
    const qs = new URLSearchParams({ path, offset: String(offset), limit: String(CHUNK) });
    const res = await fetch(`${base(worker)}/file-content?${qs.toString()}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`file-content ${path} → ${await errorMessage(res)}`);
    const body = (await res.json()) as FileContentResponse;
    out += body.content ?? '';
    if (body.eof) return out;
    offset = body.next_offset;
    if (!Number.isFinite(offset) || offset <= 0) return out;
  }
  return out;
}

/** 收集 KB 内全部 md 文件（MEMORY.md + memory/** + digest/**，深度≤4） */
async function collectMdFiles(worker: string): Promise<{ files: string[]; unavailable: boolean }> {
  const files: string[] = ['MEMORY.md'];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries: TreeEntry[] | null;
    try {
      entries = await fetchTree(worker, dir);
    } catch {
      return; // 单目录失败不拖垮全量
    }
    if (entries === null) return;
    for (const e of entries) {
      if (e.kind === 'directory') await walk(e.path, depth + 1);
      else if (e.name.toLowerCase().endsWith('.md')) files.push(e.path);
    }
  };
  let unavailable = false;
  const r1 = await fetchTree(worker, 'memory');
  if (r1 === null) unavailable = true;
  const r2 = await fetchTree(worker, 'digest');
  if (r2 === null) unavailable = true;
  if (unavailable) return { files: [], unavailable: true };
  if (r1) await walk('memory', 1);
  if (r2) await walk('digest', 1);
  // 去重（MEMORY.md 不在 memory/ 内，此处仅防重复目录文件）
  return { files: Array.from(new Set(files)), unavailable: false };
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
  // KB 数据面（workspace-files）是 QwenPaw 运行时专属能力（FUNC-10）：
  // 非 qwenpaw Worker 的 tree 端点 404/形状失配，必须整体过滤。
  const kbWorkers = useMemo(
    () => (workers ?? []).filter((wd) => wd.runtime === 'qwenpaw'),
    [workers],
  );
  const effectiveWorker = kbWorkers.some((wd) => wd.name === worker)
    ? worker
    : kbWorkers[0]?.name || '';
  const noKbWorker = (workers?.length ?? 0) > 0 && kbWorkers.length === 0;

  const [unavailable, setUnavailable] = useState(false);
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
      const { files, unavailable: un } = await collectMdFiles(w);
      if (gen !== genRef.current) return;
      if (un) { setUnavailable(true); return; }
      // MEMORY.md 永远在（KB 布局根文件）
      const targets = files.filter((f) => f !== 'MEMORY.md').slice(0, MAX_GRAPH_FILES - 1);
      const all = ['MEMORY.md', ...targets];
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

  // 延迟一个宏任务（同 B5：避免 effect 同步阶段 setState 链）
  useEffect(() => {
    if (!effectiveWorker) return;
    const t = setTimeout(() => {
      setUnavailable(false);
      setLoadError('');
      setGraph(null);
      setExpanded({});
      setPreviewPath(null);
      setLoading(true);
      void loadGraph(effectiveWorker).finally(() => setLoading(false));
    }, 0);
    return () => clearTimeout(t);
  }, [effectiveWorker, loadGraph]);

  const loadDir = useCallback(async (dir: string) => {
    setTreeDirsLoading((m) => ({ ...m, [dir]: true }));
    try {
      const entries = await fetchTree(effectiveWorker, dir);
      if (entries === null) { setUnavailable(true); return; }
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
      const text = await fetchFullContent(effectiveWorker, path);
      if (text === null) { setPreviewError('文件不存在或端点未就绪'); }
      else { setPreviewText(text); }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : '读取失败');
    } finally {
      setPreviewLoading(false);
    }
  }, [effectiveWorker]);

  const treeRoots: { label: string; path: string; kind: 'file' | 'directory' }[] = [
    { label: 'MEMORY.md', path: 'MEMORY.md', kind: 'file' },
    { label: 'memory', path: 'memory', kind: 'directory' },
    { label: 'digest', path: 'digest', kind: 'directory' },
  ];

  return (
    <div className="space-y-4 p-4">
      <SectionHeader
        title="知识库"
        description="浏览 Worker 的记忆文档：MEMORY.md 与 memory、digest 目录，支持 wikilink 关系图谱"
        actions={
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border bg-transparent px-2 text-xs"
              value={effectiveWorker}
              onChange={(e) => setWorker(e.target.value)}
              aria-label="选择 Worker"
            >
              {kbWorkers.map((wd) => (
                <option key={wd.name} value={wd.name}>{wd.name}</option>
              ))}
            </select>
            {effectiveWorker && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title="知识库数据来自该 Worker 的记忆目录，当前仅支持 QwenPaw 运行时">
                QwenPaw
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={loading || graphLoading}
              onClick={() => effectiveWorker && void loadGraph(effectiveWorker)}
            >
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading || graphLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              刷新
            </Button>
          </div>
        }
        isRefreshing={loading || graphLoading}
      />

      {noKbWorker ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>知识库当前仅支持 QwenPaw 运行时的 Worker；当前实例没有 QwenPaw Worker，请先用该运行时创建 Worker。</span>
        </div>
      ) : unavailable ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>当前 Controller 版本未提供知识库端点，升级 AgentTeams 后自动生效。</span>
        </div>
      ) : loadError ? (
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
              {treeRoots.map((root) => {
                const entries = expanded[root.path];
                const open = !!entries;
                return (
                  <div key={root.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-accent"
                      onClick={() => {
                        if (root.kind === 'file') void openPreview(root.path);
                        else if (!open) void loadDir(root.path);
                        else setExpanded((m) => ({ ...m, [root.path]: [] }));
                      }}
                    >
                      {root.kind === 'directory'
                        ? (open ? <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" /> : <Folder className="h-3.5 w-3.5" aria-hidden="true" />)
                        : <FileText className="h-3.5 w-3.5" aria-hidden="true" />}
                      <span className="truncate font-medium">{root.label}</span>
                      {root.kind === 'directory' && treeDirsLoading[root.path] && (
                        <Loader2 className="ml-auto h-3 w-3 animate-spin" aria-hidden="true" />
                      )}
                    </button>
                    {open && (entries ?? []).map((e) => (
                      <TreeRow key={e.path} entry={e} depth={1} onFile={openPreview} onDir={(d) => void loadDir(d)} loading={treeDirsLoading} expandedMap={expanded} setExpanded={setExpanded} />
                    ))}
                  </div>
                );
              })}
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
