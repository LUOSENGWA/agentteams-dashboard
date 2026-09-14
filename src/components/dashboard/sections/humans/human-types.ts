export type SortKey = 'name' | 'phase';

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'name', label: '按名称' },
  { value: 'phase', label: '按阶段' },
];

export const PERMISSION_LEVELS = [1, 2, 3] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

// Controller 权限等级语义（docs/usage/import-worker.md +
// design/internal/team-worker-proposal.md）：L1 > L2 > L3，高级别包含低级别
// 全部权限。1 = 管理员（等同 Admin），2 = 团队成员（Team 级），3 = Worker 级。
export const PERMISSION_LABELS: Record<number, string> = {
  1: '管理员',
  2: '团队成员',
  3: 'Worker',
};

// 颜色与插件 LEVEL_META 对齐：L1 红 / L2 绿 / L3 蓝
export const PERMISSION_BADGE_CLASSES: Record<number, string> = {
  1: 'bg-red-500/10 text-red-600 dark:text-red-400',
  2: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  3: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
};
