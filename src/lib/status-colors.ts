// Shared status/outcome badge palettes (UI-01): single source for the
// project views so projects-section and tasks-section cannot drift.
// All text colors are dual-mode (light-theme 700 / dark-theme 300) to
// keep WCAG-readable contrast on the /15 tinted badge backgrounds.
import type { ProjectStatus } from '@/lib/agentteams-projects-api';
import type { BoardTask } from '@/hooks/use-task-board';

export const PROJECT_STATUS_COLOR: Record<ProjectStatus, string> = {
  planning: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30',
  active: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30',
  paused: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};

export const OUTCOME_COLOR: Record<NonNullable<BoardTask['outcome']>, string> = {
  SUCCESS: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  SUCCESS_WITH_NOTES: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 border-cyan-500/30',
  REVISION_NEEDED: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  BLOCKED: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
};
