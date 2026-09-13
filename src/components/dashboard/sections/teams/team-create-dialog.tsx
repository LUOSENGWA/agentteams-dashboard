'use client';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { CreateTeamRequest, WorkerResponse } from '@/lib/agentteams-api';
import {
  MemberPicker,
  workerPickerLabel,
} from '@/components/dashboard/sections/shared/member-picker';

export function parseWorkerNames(value: string): string[] {
  return value.split(/[,，]/).map((name) => name.trim()).filter(Boolean);
}

const RUNTIME_OPTIONS: { value: WorkerRuntime; label: string }[] = [
  { value: 'openclaw', label: 'OpenClaw（默认）' },
  { value: 'copaw', label: 'CoPaw' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'qwenpaw', label: 'QwenPaw' },
  { value: 'deepseek-harness', label: 'DeepSeek Harness（实验）' },
];

/**
 * 创建团队（对齐插件建队卡：Worker 全部从已有 CR 选择，不允许自由输入——
 * 悬空引用在输入层即不可能；先建的 Worker 再编入团队，与插件一致）。
 */
export function TeamCreateDialog({
  open,
  value,
  onChange,
  isPending,
  onOpenChange,
  onSubmit,
  workers,
}: {
  open: boolean;
  value: CreateTeamRequest;
  onChange: (_next: CreateTeamRequest) => void;
  isPending: boolean;
  onOpenChange: (_open: boolean) => void;
  onSubmit: () => void;
  workers: WorkerResponse[];
}) {
  const workerNames = value.workerNames ?? [];
  const selectedWorkers = workers.filter((worker) => workerNames.includes(worker.name));
  const workersWithoutModel = selectedWorkers.filter((worker) => !worker.model?.trim());
  // Leader 也是从已有 Worker 里选；Worker 选项排除当前 Leader（不重复编入）。
  const workerOptions = workers
    .filter((worker) => worker.name !== value.leader?.name)
    .map((worker) => ({
      value: worker.name,
      label: workerPickerLabel(worker.name, worker.model),
    }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>创建团队</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>名称 *</Label>
            <Input
              value={value.name}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              placeholder="team-name"
            />
          </div>
          <div className="space-y-2">
            <Label>Leader *</Label>
            {workers.length > 0 ? (
              <Select
                value={value.leader?.name || undefined}
                onValueChange={(name) => onChange({ ...value, leader: { name } })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择 Leader（已有 Worker）" />
                </SelectTrigger>
                <SelectContent>
                  {workers.map((worker) => (
                    <SelectItem key={worker.name} value={worker.name}>
                      {workerPickerLabel(worker.name, worker.model)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground">
                暂无 Worker，先到 Worker 列表创建后再建团队
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>团队名称</Label>
            <Input
              value={value.teamName || ''}
              onChange={(e) => onChange({ ...value, teamName: e.target.value })}
              placeholder="显示名称（可选）"
            />
          </div>
          <div className="space-y-2">
            <Label>描述</Label>
            <Textarea
              value={value.description || ''}
              onChange={(e) => onChange({ ...value, description: e.target.value })}
              placeholder="团队描述（可选）"
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label>Workers（从已有 Worker 选择）</Label>
            <MemberPicker
              options={workerOptions}
              selected={workerNames}
              onAdd={(name) =>
                onChange({ ...value, workerNames: [...workerNames, name] })
              }
              onRemove={(name) =>
                onChange({
                  ...value,
                  workerNames: workerNames.filter((w) => w !== name),
                })
              }
              placeholder="选择 Worker 添加…"
            />
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
            <p>团队模型由 Leader 运行时与成员 Worker 的“请求模型别名”分别管理。</p>
            {workersWithoutModel.length > 0 ? (
              <p className="text-amber-600 dark:text-amber-400">
                以下已选 Worker 仍需配置模型：{workersWithoutModel.map((worker) => worker.name).join('、')}
              </p>
            ) : selectedWorkers.length > 0 ? (
              <p className="text-emerald-600 dark:text-emerald-400">已选 Worker 均已填写请求模型别名。</p>
            ) : (
              <p>添加成员后可在此检查成员模型配置。</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={onSubmit}
            disabled={!value.name || !value.leader?.name || isPending}
            className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-600 hover:to-teal-600"
          >
            {isPending ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
