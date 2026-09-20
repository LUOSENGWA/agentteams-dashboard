'use client';

import type { WorkerSessionState } from '@/lib/worker-session-state';

// 8px session dot (A17). Palette (9/14 design freeze):
//   blue #3b82f6 = running (breathing, 1.2s pulse)
//   green #52c41a = finished (steady)
//   gray #c0c4cc  = no task (steady)
// The breathing animation lives on a CSS class (globals.css,
// `wt-session-pulse`) so prefers-reduced-motion can kill it — an
// inline animation cannot be overridden.

const STATE_STYLE: Record<WorkerSessionState, { color: string; label: string; pulse: boolean }> = {
  running: { color: '#3b82f6', label: '运行中', pulse: true },
  done: { color: '#52c41a', label: '运行完成', pulse: false },
  // Theme token: the old fixed #c0c4cc is ~1.6:1 on light backgrounds (UI-02).
  idle: { color: 'var(--muted-foreground)', label: '无任务', pulse: false },
};

export function WorkerSessionDot({
  state,
  className = '',
}: {
  state: WorkerSessionState;
  className?: string;
}) {
  const s = STATE_STYLE[state];
  return (
    <span
      aria-label={s.label}
      title={s.label}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.pulse ? 'wt-session-pulse' : ''} ${className}`}
      style={{ backgroundColor: s.color }}
    />
  );
}

/** Team-room variant: the blue running dot, or nothing at all. */
export function WorkerSessionRunningDot({ running }: { running: boolean }) {
  if (!running) return null;
  return <WorkerSessionDot state="running" />;
}
