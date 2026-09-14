'use client';

// 产物（9/14 罗总：「在左边加个产物的 tab，照搬插件的产物功能」——方向：
// 插件 Artifacts.tsx → dashboard 侧边栏 section）。
//
// 功能对齐插件 Artifacts tab（v0.4.98 再版 9 形态）：
//   · 正源：Controller 项目产物（#1169 端点，dashboard 走 /api/agentteams/
//     projects 代理）——项目 → 任务 → 产物文件树，左右分栏
//   · 排序（时间新→旧/旧→新/名称）+ 团队筛选（纯前端）
//   · 文件按扩展名分类型（图片/文档/数据/代码/其他）+ 图标
//   · 预览（md 走 MarkdownMessage、图片 <img>、文本 <pre>）+ 下载
//     （fetch→blob，代理透传 controller JSON 错误体→显示真实原因）
//   · 降级横幅：api-not-deployed（404 未升级）/ controller-error（5xx）
// dashboard 版差异（如实记录，非照搬项）：
//   · 无「房间附件扫描」fallback——插件该 fallback 扫 Matrix 房间 m.file，
//     dashboard 聊天区有独立的文件浏览，不在此 section 重复；
//   · 无树宽拖拽（侧边栏空间有限，固定 280px）。
//
// 数据契约（agentteams-projects-api.ts，与 project_handler.go 对齐）：
//   listProjects()            → { projects, degraded, degradedReason, error }
//   getProjectWorkflow(id, { includeTasks: true, teamId })
//                             → tasks_detail[]（deliverables[] + result_path）
//   getTaskArtifactUrl(id, taskId, path?)  → 下载/预览 URL（白名单在 controller）

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  Eye,
  File,
  FileCode2,
  FileImage,
  FileText,
  FolderOpen,
  Loader2,
  SearchX,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SectionHeader } from '@/components/dashboard/section-header';
import {
  getProjectWorkflow,
  getTaskArtifactUrl,
  listProjects,
  type ProjectListResponse,
  type ProjectSummary,
  type WorkflowTaskDetail,
} from '@/lib/agentteams-projects-api';
import { agentteamsApi } from '@/lib/agentteams-api';
import { MarkdownMessage } from '@/components/dashboard/sections/chat/markdown-message';

// ── 文件类型（与插件 Artifacts.kindOf 同款扩展名分组）──────────────────
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']);
const DOC_EXT = new Set(['md', 'markdown', 'txt', 'rst', 'pdf', 'doc', 'docx', 'html']);
const DATA_EXT = new Set(['json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'sql']);
const CODE_EXT = new Set(['py', 'ts', 'tsx', 'js', 'jsx', 'go', 'rs', 'java', 'c', 'cpp', 'sh', 'toml', 'ini']);

type ArtifactKind = 'image' | 'document' | 'data' | 'code' | 'other';

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function kindOf(name: string): ArtifactKind {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (DOC_EXT.has(ext)) return 'document';
  if (DATA_EXT.has(ext)) return 'data';
  if (CODE_EXT.has(ext)) return 'code';
  return 'other';
}

const KIND_META: Record<ArtifactKind, { label: string; icon: LucideIcon; className: string }> = {
  image: { label: '图片', icon: FileImage, className: 'text-amber-500' },
  document: { label: '文档', icon: FileText, className: 'text-blue-500' },
  data: { label: '数据', icon: Database, className: 'text-emerald-500' },
  code: { label: '代码', icon: FileCode2, className: 'text-violet-500' },
  other: { label: '其他', icon: File, className: 'text-muted-foreground' },
};

/** 统一文件条目（插件 FileEntry 的 dashboard 版：无 mxc 直链 fallback）。 */
interface FileEntry {
  key: string;
  name: string;
  kind: ArtifactKind;
  source: string; // 项目标题
  taskLabel: string; // task_id / 指派人
  projectId: string;
  teamId?: string;
  taskId: string;
  /** 下载/预览参数：path=undefined → 结果文件（result_path）。 */
  path?: string;
}

type SortMode = 'time_desc' | 'time_asc' | 'name';

type Selection =
  | { kind: 'root' }
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string }
  | { kind: 'file'; file: FileEntry };

interface PreviewState {
  entry: FileEntry;
  status: 'loading' | 'ready' | 'binary' | 'error';
  text?: string;
  error?: string;
}

// 预览拉取上限（1MB）：更大的文件不做内联预览，引导下载。
const PREVIEW_MAX_BYTES = 1024 * 1024;

function projectTs(p: ProjectSummary): number {
  const raw = p.updated_at ?? p.created_at;
  if (typeof raw === 'string') return Date.parse(raw) || 0;
  if (typeof raw === 'number') return raw;
  return 0;
}

export function ArtifactsSection() {
  const [data, setData] = useState<ProjectListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tasksByProject, setTasksByProject] = useState<Record<string, WorkflowTaskDetail[]>>({});
  const [tasksLoading, setTasksLoading] = useState<Record<string, boolean>>({});
  const [tasksError, setTasksError] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Selection>({ kind: 'root' });
  const [sort, setSort] = useState<SortMode>('time_desc');
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [teamNames, setTeamNames] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await listProjects();
      setData(list);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '项目列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 团队筛选选项（失败不阻塞主流程）。
    agentteamsApi
      .listTeams()
      .then((teams) => setTeamNames(teams.map((t) => t.name)))
      .catch(() => setTeamNames([]));
  }, [refresh]);

  const projects = useMemo(() => data?.projects ?? [], [data]);

  const sortedProjects = useMemo(() => {
    const list = projects.filter(
      (p) => teamFilter === 'all' || p.team_id === teamFilter,
    );
    const withTime = sort !== 'name' && list.some((p) => projectTs(p) > 0);
    return [...list].sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title);
      if (withTime) {
        const ta = projectTs(a);
        const tb = projectTs(b);
        // 无时间戳的条目垫底
        if (ta === 0 && tb === 0) return a.title.localeCompare(b.title);
        if (ta === 0) return 1;
        if (tb === 0) return -1;
        return sort === 'time_desc' ? tb - ta : ta - tb;
      }
      return a.title.localeCompare(b.title);
    });
  }, [projects, sort, teamFilter]);

  /** 展开项目时懒加载 tasks_detail（对齐插件：树节点按需拉取）。 */
  const loadTasks = useCallback(async (project: ProjectSummary) => {
    setTasksLoading((prev) => ({ ...prev, [project.project_id]: true }));
    setTasksError((prev) => {
      const next = { ...prev };
      delete next[project.project_id];
      return next;
    });
    try {
      const wf = await getProjectWorkflow(project.project_id, {
        includeTasks: true,
        teamId: project.team_id,
      });
      setTasksByProject((prev) => ({
        ...prev,
        [project.project_id]: wf.tasks_detail ?? [],
      }));
    } catch (err) {
      setTasksError((prev) => ({
        ...prev,
        [project.project_id]: err instanceof Error ? err.message : '任务加载失败',
      }));
    } finally {
      setTasksLoading((prev) => ({ ...prev, [project.project_id]: false }));
    }
  }, []);

  const toggleProject = useCallback(
    (project: ProjectSummary) => {
      setExpanded((prev) => {
        const next = { ...prev, [project.project_id]: !prev[project.project_id] };
        if (next[project.project_id]) {
          void loadTasks(project);
        }
        return next;
      });
    },
    [loadTasks],
  );

  /** 全部产物文件条目（仅已展开/已加载的项目——对齐插件按需语义）。 */
  const allFiles = useMemo<FileEntry[]>(() => {
    const out: FileEntry[] = [];
    for (const project of projects) {
      const tasks = tasksByProject[project.project_id];
      if (!tasks) continue;
      const title = project.title || project.project_id;
      for (const task of tasks) {
        const taskLabel = task.assigned_to
          ? `${task.task_id} · ${task.assigned_to}`
          : task.task_id;
        if (task.result_path) {
          out.push({
            key: `${project.project_id}/${task.task_id}/result`,
            name: task.result_path.split('/').pop() || '结果文件',
            kind: kindOf(task.result_path.split('/').pop() || 'result'),
            source: title,
            taskLabel,
            projectId: project.project_id,
            teamId: project.team_id,
            taskId: task.task_id,
          });
        }
        for (const d of Array.isArray(task.deliverables)
          ? task.deliverables.filter((x): x is string => typeof x === 'string')
          : []) {
          const name = d.split('/').pop() || d;
          out.push({
            key: `${project.project_id}/${task.task_id}/${d}`,
            name,
            kind: kindOf(name),
            source: title,
            taskLabel,
            projectId: project.project_id,
            teamId: project.team_id,
            taskId: task.task_id,
            path: d,
          });
        }
      }
    }
    return out;
  }, [projects, tasksByProject]);

  const visibleFiles = useMemo<FileEntry[]>(() => {
    switch (selected.kind) {
      case 'file':
        return [selected.file];
      case 'task':
        return allFiles.filter(
          (f) => f.projectId === selected.projectId && f.taskId === selected.taskId,
        );
      case 'project':
        return allFiles.filter((f) => f.projectId === selected.projectId);
      case 'root':
        return allFiles;
    }
  }, [selected, allFiles]);

  const openPreview = useCallback((entry: FileEntry) => {
    const url = getTaskArtifactUrl(entry.projectId, entry.taskId, entry.path);
    setPreview({ entry, status: 'loading' });
    void (async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { error?: string; message?: string };
            if (typeof body?.message === 'string' && body.message) detail = body.message;
            else if (typeof body?.error === 'string' && body.error) detail = body.error;
          } catch {
            // non-JSON error body; keep the status
          }
          setPreview({ entry, status: 'error', error: detail });
          return;
        }
        const type = res.headers.get('content-type') ?? '';
        if (entry.kind === 'image' || type.startsWith('image/')) {
          // 图片：<img> 走代理直链（同域，携带会话 cookie）
          setPreview({ entry, status: 'ready' });
          return;
        }
        const blob = await res.blob();
        if (blob.size > PREVIEW_MAX_BYTES) {
          setPreview({ entry, status: 'binary' });
          return;
        }
        const text = await blob.text();
        // 文本嗅探：含 NUL 字节视为二进制
        if (text.includes('\u0000')) {
          setPreview({ entry, status: 'binary' });
          return;
        }
        setPreview({ entry, status: 'ready', text });
      } catch (err) {
        setPreview({ entry, status: 'error', error: err instanceof Error ? err.message : '预览失败' });
      }
    })();
  }, []);

  const degraded = data?.degraded ? data : null;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="产物"
        description="项目任务产物（Controller 项目端点）：项目 → 任务 → 文件，支持预览与下载"
        isLive
        onRefresh={() => void refresh()}
        isRefreshing={loading}
        actions={
          <div className="flex items-center gap-2">
            <Select value={sort} onValueChange={(v) => setSort(v as SortMode)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="time_desc">时间 新→旧</SelectItem>
                <SelectItem value="time_asc">时间 旧→新</SelectItem>
                <SelectItem value="name">名称 A→Z</SelectItem>
              </SelectContent>
            </Select>
            <Select value={teamFilter} onValueChange={setTeamFilter}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部团队</SelectItem>
                {teamNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      {loadError && (
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>项目列表加载失败：{loadError}</span>
        </div>
      )}

      {degraded && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-medium">
              {degraded.degradedReason === 'api-not-deployed'
                ? 'Controller 未升级到含项目产物列表的版本（404）'
                : 'Controller 项目列表请求失败'}
            </p>
            {degraded.error && (
              <p className="mt-1 break-all text-muted-foreground">{degraded.error.slice(0, 220)}</p>
            )}
            <p className="mt-1 text-muted-foreground">
              产物功能依赖 Controller 项目端点（#1169）——升级 Controller 后刷新即可。
            </p>
          </div>
        </div>
      )}

      <div className="flex items-stretch overflow-hidden rounded-lg border bg-background/40" style={{ minHeight: 420 }}>
        {/* 左栏：产物树（全部 → 项目 → 任务） */}
        <div className="w-[280px] shrink-0 overflow-y-auto border-r bg-muted/20 p-2" style={{ maxHeight: 'calc(100vh - 320px)', minHeight: 420 }}>
          <TreeNode
            label="全部产物"
            icon={FolderOpen}
            depth={0}
            selected={selected.kind === 'root'}
            onClick={() => setSelected({ kind: 'root' })}
            trailing={allFiles.length > 0 ? String(allFiles.length) : undefined}
          />
          {sortedProjects.length === 0 && !loading && !degraded && (
            <p className="px-2 py-3 text-xs text-muted-foreground">暂无项目</p>
          )}
          {sortedProjects.map((project) => {
            const tasks = tasksByProject[project.project_id];
            const isExpanded = !!expanded[project.project_id];
            return (
              <div key={project.project_id}>
                <div
                  className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-xs cursor-pointer hover:bg-muted ${
                    selected.kind === 'project' && selected.projectId === project.project_id
                      ? 'bg-muted font-medium'
                      : ''
                  }`}
                  onClick={() => {
                    setSelected({ kind: 'project', projectId: project.project_id });
                    if (!isExpanded) void loadTasks(project);
                  }}
                >
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 hover:bg-muted-foreground/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleProject(project);
                    }}
                    aria-label={isExpanded ? '折叠' : '展开'}
                  >
                    {tasksLoading[project.project_id] ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                  <span className="truncate" title={project.title || project.project_id}>
                    {project.title || project.project_id}
                  </span>
                  {project.status && project.status !== 'active' && (
                    <Badge variant="secondary" className="ml-auto h-4 px-1 text-[9px] shrink-0">
                      {project.status}
                    </Badge>
                  )}
                </div>
                {isExpanded && (
                  <div className="ml-4 border-l pl-1">
                    {tasksError[project.project_id] && (
                      <p className="px-1.5 py-1 text-[10px] text-red-600 dark:text-red-400">
                        {tasksError[project.project_id].slice(0, 120)}
                      </p>
                    )}
                    {tasks && tasks.length === 0 && (
                      <p className="px-1.5 py-1 text-[10px] text-muted-foreground">无任务</p>
                    )}
                    {tasks?.map((task) => {
                      const taskFiles = allFiles.filter(
                        (f) => f.projectId === project.project_id && f.taskId === task.task_id,
                      );
                      return (
                        <div
                          key={task.task_id}
                          className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] cursor-pointer hover:bg-muted ${
                            selected.kind === 'task' && selected.projectId === project.project_id && selected.taskId === task.task_id
                              ? 'bg-muted font-medium'
                              : ''
                          }`}
                          onClick={() =>
                            setSelected({
                              kind: 'task',
                              projectId: project.project_id,
                              taskId: task.task_id,
                            })
                          }
                        >
                          <span className="truncate font-mono text-[10px] text-muted-foreground" title={task.task_id}>
                            {task.task_id}
                          </span>
                          {task.assigned_to && (
                            <span className="truncate text-[10px] text-muted-foreground">· {task.assigned_to}</span>
                          )}
                          <span className="ml-auto text-[9px] text-muted-foreground shrink-0">
                            {taskFiles.length > 0 ? `${taskFiles.length} 文件` : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 右栏：文件列表 */}
        <div className="flex-1 overflow-y-auto p-3" style={{ maxHeight: 'calc(100vh - 320px)', minHeight: 420 }}>
          {visibleFiles.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <SearchX className="h-8 w-8" aria-hidden="true" />
              <p className="text-xs">
                {selected.kind === 'root' && sortedProjects.length > 0
                  ? '暂无已加载的产物——展开左侧项目加载任务产物'
                  : '暂无产物文件'}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {visibleFiles.map((entry) => {
                const meta = KIND_META[entry.kind];
                const KindIcon = meta.icon;
                const isFileSelected =
                  selected.kind === 'file' && selected.file.key === entry.key;
                return (
                  <div
                    key={entry.key}
                    className={`flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-xs cursor-pointer hover:border-border hover:bg-muted/50 ${
                      isFileSelected ? 'border-border bg-muted/70' : ''
                    }`}
                    onClick={() => setSelected({ kind: 'file', file: entry })}
                  >
                    <KindIcon className={`h-4 w-4 shrink-0 ${meta.className}`} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium" title={entry.name}>
                        {entry.name}
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {entry.source}
                        {entry.path ? '' : ' · 结果文件'}
                      </p>
                    </div>
                    <span className="hidden text-[10px] text-muted-foreground sm:inline shrink-0">
                      {entry.taskLabel}
                    </span>
                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="预览"
                        onClick={() => openPreview(entry)}
                      >
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <ArtifactDownloadButton
                        href={getTaskArtifactUrl(entry.projectId, entry.taskId, entry.path)}
                        filename={entry.name}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 预览对话框 */}
      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="sm:max-w-2xl max-w-[95vw]">
          <DialogHeader>
            <DialogTitle className="truncate">
              {preview ? `${preview.entry.name} — 预览` : ''}
            </DialogTitle>
            <DialogDescription className="truncate">
              {preview ? `${preview.entry.source} · ${preview.entry.taskLabel}` : ''}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="max-h-[60vh] overflow-y-auto rounded-md border bg-muted/20 p-3">
              {preview.status === 'loading' && (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  加载中…
                </div>
              )}
              {preview.status === 'error' && (
                <p className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                  <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                  预览失败：{preview.error}
                </p>
              )}
              {preview.status === 'binary' && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                  二进制或超过 1MB 的文件不支持内联预览，请直接用右侧「下载」。
                </p>
              )}
              {preview.status === 'ready' &&
                (preview.entry.kind === 'image' ? (
                  <img
                    src={getTaskArtifactUrl(preview.entry.projectId, preview.entry.taskId, preview.entry.path)}
                    alt={preview.entry.name}
                    className="max-w-full rounded-md"
                  />
                ) : ['md', 'markdown'].includes(extOf(preview.entry.name)) ? (
                  <MarkdownMessage content={preview.text ?? ''} formattedContent={undefined} />
                ) : (
                  <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                    {preview.text}
                  </pre>
                ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TreeNode({
  label,
  icon: Icon,
  depth,
  selected,
  onClick,
  trailing,
}: {
  label: string;
  icon: LucideIcon;
  depth: number;
  selected: boolean;
  onClick: () => void;
  trailing?: string;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs cursor-pointer hover:bg-muted ${
        selected ? 'bg-muted font-medium' : ''
      }`}
      style={{ marginLeft: depth * 12 }}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {trailing && <span className="ml-auto text-[10px] text-muted-foreground">{trailing}</span>}
    </div>
  );
}

/** 下载（fetch→blob，代理透传 controller JSON 错误体→toast 真实原因）。
 *  与 projects-section 的 ArtifactLink 同款语义（独立实现避免跨 section 耦合）。 */
function ArtifactDownloadButton({ href, filename }: { href: string; filename: string }) {
  const [downloading, setDownloading] = useState(false);
  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(href, { cache: 'no-store' });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          if (typeof body?.message === 'string' && body.message) detail = body.message;
          else if (typeof body?.error === 'string' && body.error) detail = body.error;
        } catch {
          // non-JSON error body; keep the status
        }
        toast.error(`下载失败：${detail}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      title="下载"
      disabled={downloading}
      onClick={() => void handleDownload()}
    >
      {downloading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </Button>
  );
}
