'use client';

// 技能分配（worker × skill 矩阵）：Worker 详情内 spec.skills 勾选。
// 语义 = 全量替换：PUT /workers skills 非 nil 即整表替换（controller
// resource_handler.go:255 `if req.Skills != nil { worker.Spec.Skills = req.Skills }`），
// 保存提交勾选全集，取消勾选 = 移除该技能。
// 目录 = GET /skills（技能中心同源，MinIO skills bucket）；勾选基线 =
// worker.skills（CR spec.skills，含 nacos:// 前缀条目）。不在目录中的存量
// 条目单列（琥珀标记）——全量替换会清掉它们，必须让用户看得见。
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useSkills } from '@/hooks/use-skill-center';
import { agentteamsApi } from '@/lib/agentteams-api';
import type { WorkerResponse } from '@/lib/agentteams-api';

export function WorkerSkillAssign({
  worker,
  onSaved,
}: {
  worker: WorkerResponse;
  onSaved?: () => void;
}) {
  const { data: catalog = { skills: [], total: 0 } } = useSkills();
  const qc = useQueryClient();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [inited, setInited] = useState<string | null>(null);

  // 勾选基线 = CR spec.skills。React 官方「reset state to respond to props
  // changes」模式：渲染期间按 name 重置（换 Worker / 重开详情时生效；保存
  // 成功后 prop 未变 → 不重置，避免把用户勾选冲掉）。
  if (inited !== worker.name) {
    setInited(worker.name);
    setChecked(new Set(worker.skills ?? []));
  }

  const catalogNames = useMemo(
    () => new Set(catalog.skills.map((s) => s.name)),
    [catalog.skills],
  );
  const strays = useMemo(
    () => [...(worker.skills ?? [])].filter((s) => !catalogNames.has(s)),
    [worker.skills, catalogNames],
  );
  const baseSkills = useMemo(() => new Set(worker.skills ?? []), [worker.skills]);

  const dirty = useMemo(() => {
    if (inited !== worker.name) return false;
    if (checked.size !== baseSkills.size) return true;
    for (const s of checked) if (!baseSkills.has(s)) return true;
    return false;
  }, [checked, baseSkills, inited, worker.name]);

  const save = useMutation({
    mutationFn: (skills: string[]) =>
      agentteamsApi.updateWorker(worker.name, { skills }),
    onSuccess: () => {
      // 详情内「已分发技能」chip 与列表同 key 前缀，一并失效
      qc.invalidateQueries({ queryKey: ['agentteams-worker-skills', worker.name] });
      onSaved?.();
    },
  });

  const toggle = (name: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const allNames = useMemo(
    () => [...new Set([...catalog.skills.map((s) => s.name), ...strays])],
    [catalog.skills, strays],
  );

  if (allNames.length === 0 && baseSkills.size === 0) {
    return (
      <div className="pt-2">
        <p className="text-muted-foreground mb-1">技能分配</p>
        <p className="text-xs text-muted-foreground">
          技能目录为空——先在「资源中心 → 技能」上传技能包，或直接在上方上传。
        </p>
      </div>
    );
  }

  return (
    <div className="pt-2">
      <div className="flex items-center justify-between mb-1">
        <p className="text-muted-foreground">技能分配（保存 = 全量替换）</p>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setChecked(new Set(allNames))}
          >
            全选
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setChecked(new Set())}
          >
            清空
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground mb-2">
        勾选要分配给该 Worker 的技能；取消勾选即移除。
        {strays.length > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            有 {strays.length} 个已分配技能不在目录中，保存前请确认是否保留。
          </span>
        )}
      </p>
      <div className="space-y-1 max-h-48 overflow-y-auto rounded-md border border-border/60 p-2">
        {catalog.skills.map((s) => (
          <label
            key={s.name}
            className="flex items-center gap-2 text-xs cursor-pointer py-0.5"
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={checked.has(s.name)}
              onChange={() => toggle(s.name)}
            />
            <span className="font-mono">{s.name}</span>
            {s.source === 'nacos' && (
              <Badge variant="secondary" className="text-[10px] px-1 h-4">
                nacos
              </Badge>
            )}
            {s.description && (
              <span className="text-muted-foreground truncate flex-1">
                {s.description}
              </span>
            )}
          </label>
        ))}
        {strays.map((s) => (
          <label
            key={s}
            className="flex items-center gap-2 text-xs cursor-pointer py-0.5"
          >
            <input
              type="checkbox"
              className="accent-amber-500"
              checked={checked.has(s)}
              onChange={() => toggle(s)}
            />
            <span className="font-mono">{s}</span>
            <Badge variant="outline" className="text-[10px] px-1 h-4 text-amber-600 dark:text-amber-400">
              不在目录
            </Badge>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <Button
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate([...checked])}
        >
          {save.isPending ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Check className="w-3 h-3 mr-1" />
          )}
          保存分配
        </Button>
        {save.isSuccess && (
          <span className="text-xs text-green-600 dark:text-green-400">
            已保存（{[...checked].length} 个技能）
          </span>
        )}
      </div>
      {save.isError && (
        <div className="flex items-start gap-2 mt-2 text-xs text-red-700 dark:text-red-300">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{save.error?.message ?? '保存失败'}</span>
        </div>
      )}
    </div>
  );
}
