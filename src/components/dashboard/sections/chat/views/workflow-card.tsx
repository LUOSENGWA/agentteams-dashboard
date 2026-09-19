import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { isProjectMiss, workflowLiveFromProject } from '@/lib/chat-workflow-live';
import { getProjectWorkflow } from '@/lib/agentteams-projects-api';
import type { WorkflowItem, WorkflowPayload } from '@/lib/a2ui/workflow';
import { CircleCheck, CircleX, Loader2, Workflow } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

const COMPLETE_STATUSES = new Set(['completed', 'success', 'done']);
const ERROR_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled']);

function itemLabel(item: WorkflowItem, fallback: string) {
  return item.title || item.name || item.id || fallback;
}

function statusLabel(status?: string) {
  if (!status) return '等待中';
  if (COMPLETE_STATUSES.has(status)) return '已完成';
  if (ERROR_STATUSES.has(status)) return '失败';
  if (status === 'in_progress' || status === 'running') return '进行中';
  return status;
}

function StatusBadge({ status }: { status?: string }) {
  const className = COMPLETE_STATUSES.has(status || '')
    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
    : ERROR_STATUSES.has(status || '')
      ? 'bg-red-500/15 text-red-700 dark:text-red-400'
      : 'bg-violet-500/15 text-violet-700 dark:text-violet-400';

  return <Badge className={className}>{statusLabel(status)}</Badge>;
}

/** Pending step glyph: static dashed ring (in_progress is the only spinning state). */
function PendingGlyph() {
  return (
    <span
      className="h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-dashed border-muted-foreground/50"
      aria-hidden="true"
    />
  );
}

/** Step status glyph: completed = solid check, failed = cross, in_progress = spinner, pending = dashed ring. */
function StepGlyph({ status }: { status?: string }) {
  if (COMPLETE_STATUSES.has(status || '')) {
    return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />;
  }
  if (ERROR_STATUSES.has(status || '')) {
    return <CircleX className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden="true" />;
  }
  if (status === 'in_progress' || status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-500" aria-hidden="true" />;
  }
  return <PendingGlyph />;
}

export function WorkflowCard({ payload }: { payload: WorkflowPayload }) {
  const runId = payload.runId || payload.run_id;
  // live 刷新（第 11 轮）：项目工作流卡是一次性发布的快照，任务推进在
  // controller 侧 → 按 runId 轮询项目 workflow 正源（与任务看板同源同频 15s）
  // overlay 状态/步骤/参与 Worker。workerflow 卡（type=workerflow）运行时靠
  // m.replace 实时编辑消息本体（消息管线已聚合）→ 不探正源。
  // runId 非项目（404/409/400）→ 停探，永久回退快照。
  const isWorkerflow = payload.type === 'workerflow';
  const liveQuery = useQuery({
    queryKey: ['chat-workflow-live', String(runId ?? '')],
    queryFn: () => getProjectWorkflow(String(runId), { includeTasks: true }),
    enabled: !!runId && !isWorkerflow,
    refetchInterval: (q) => (isProjectMiss(q.state.error) ? false : 15000),
    retry: false,
    staleTime: 5000,
  });
  const live = liveQuery.data ? workflowLiveFromProject(liveQuery.data) : null;
  const liveReady = liveQuery.isSuccess && live != null; // 查询成功=正源接通

  const title = live?.title || payload.title || payload.name || '工作流';
  const status = live?.status ?? payload.status;
  const subagents =
    live && live.subagents.length > 0 ? live.subagents : Array.isArray(payload.subagents) ? payload.subagents : [];
  const steps =
    live && live.steps.length > 0 ? live.steps : Array.isArray(payload.steps) ? payload.steps : [];
  const completedSteps = steps.filter((step) => COMPLETE_STATUSES.has(step.status || '')).length;
  const progress = steps.length ? (completedSteps / steps.length) * 100 : 0;
  const liveStamp = liveReady
    ? new Date(liveQuery.dataUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : null;

  return (
    <Card className="my-2 w-[min(100%,56rem)] max-w-full border-l-4 border-l-violet-500 py-4">
      <CardHeader className="gap-2 px-4 py-0">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Workflow className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            {title}
            {/* LIVE 徽标：正源接通且 overlay 生效才显示（快照兜底无噪音）。 */}
            {liveReady && (
              <span
                className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                title={`controller 正源 15s 轮询 · 最近更新 ${liveStamp}`}
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
                live {liveStamp}
              </span>
            )}
          </CardTitle>
          <StatusBadge status={status} />
        </div>
        {runId && <p className="font-mono text-xs text-muted-foreground">runId: {runId}</p>}
      </CardHeader>
      {(subagents.length > 0 || steps.length > 0) && (
        <CardContent className="space-y-4 px-4 pt-4">
          {subagents.length > 0 && (
            <section aria-label="参与 Worker">
              <p className="mb-2 text-xs font-medium text-muted-foreground">参与 Worker</p>
              <div className="space-y-1.5">
                {subagents.map((agent, index) => (
                  <div key={agent.id || agent.name || String(index)} className="flex items-center justify-between gap-3 text-xs">
                    <span className="min-w-0 truncate">{itemLabel(agent, `Worker ${index + 1}`)}</span>
                    <StatusBadge status={agent.status} />
                  </div>
                ))}
              </div>
            </section>
          )}
          {steps.length > 0 && (
            <section aria-label="执行步骤">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>执行步骤</span>
                <span>{completedSteps}/{steps.length}</span>
              </div>
              <Progress value={progress} aria-label={`执行进度 ${completedSteps}/${steps.length}`} />
              <div className="mt-2 space-y-1.5">
                {steps.map((step, index) => (
                  <div key={step.id || step.name || String(index)} className="flex items-center gap-2 text-xs">
                    <StepGlyph status={step.status} />
                    <span className="min-w-0 flex-1 truncate">{itemLabel(step, `步骤 ${index + 1}`)}</span>
                    <span className="text-muted-foreground">{statusLabel(step.status)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </CardContent>
      )}
    </Card>
  );
}
