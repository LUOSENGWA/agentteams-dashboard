'use client';

// Project task-transition event stream panel (controller /events read
// endpoint, merged upstream as PR #1233 — task state transition engine).
//
// Sibling of ProjectTimelinePanel: 时间线 = intervention snapshots
// (history endpoint), 事件流 = every task transition
// (delegate/ack/submit/report_progress/cancel → one event each).
//
// Data plane: cursor pagination (page 1 = oldest, `next_cursor`
// opaque). On open we load every page (max 10 × 200 = 2000 events,
// then a truncation note). While open, a 15 s poll appends from the
// retained tail cursor; `cursor_expired` (50-entry writer cap
// truncated the anchor / legacy snapshot drift) resets the load from
// the beginning. 404 (Controller predates #1233) renders the
// "active after upgrade" placeholder, not an error.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
import {
  getProjectEvents,
  type ProjectEvent,
} from '@/lib/agentteams-projects-api';
import {
  isUnsupportedEndpointError,
  loadErrorMessage,
} from '@/lib/api-error';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; events: ProjectEvent[]; truncated: boolean }
  | { kind: 'not-deployed' }
  | { kind: 'error'; message: string };

const MAX_PAGES = 10;
const PAGE_SIZE = 200;
const POLL_MS = 15_000;

/** "2026-09-18T12:34:56Z" → "09-18 12:34:56" (local time). */
function fmtEventTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Pure data fetch: page from the beginning until the tail.
 * Never touches React state — the component applies the result inside
 * promise callbacks. `signal.stopped` bails out mid-page. */
async function fetchAllProjectEvents(
  projectId: string,
  teamId: string | undefined,
  signal: { stopped: boolean },
): Promise<
  | { kind: 'ok'; events: ProjectEvent[]; truncated: boolean }
  | { kind: 'not-deployed' }
  | { kind: 'error'; message: string }
> {
  let cursor = '';
  const all: ProjectEvent[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (signal.stopped) {
      return { kind: 'ok', events: all, truncated: false };
    }
    try {
      const resp = await getProjectEvents(projectId, teamId, {
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (signal.stopped) {
        return { kind: 'ok', events: all, truncated: false };
      }
      if (resp.cursor_expired) {
        // Anchor no longer resolvable: reload from the beginning.
        // If that happens a second time, stop (avoid a loop on
        // pathological data).
        if (page > 0) return { kind: 'ok', events: all, truncated: true };
        cursor = '';
        all.length = 0;
        continue;
      }
      all.push(...resp.events);
      if (!resp.next_cursor) {
        return { kind: 'ok', events: all, truncated: false };
      }
      cursor = resp.next_cursor;
    } catch (e: unknown) {
      if (isUnsupportedEndpointError(e)) {
        return { kind: 'not-deployed' };
      }
      return { kind: 'error', message: loadErrorMessage(e, '事件流加载失败') };
    }
  }
  return { kind: 'ok', events: all, truncated: true };
}

function StatusSpan({ value }: { value: string }) {
  const tone =
    value === 'completed'
      ? 'text-emerald-600 dark:text-emerald-400'
      : value === 'in_progress' || value === 'assigned'
        ? 'text-blue-600 dark:text-blue-400'
        : value === 'cancelled'
          ? 'text-red-600 dark:text-red-400'
          : 'text-muted-foreground';
  return <span className={`font-medium ${tone}`}>{value || '—'}</span>;
}

export function ProjectEventsPanel({
  projectId,
  teamId,
}: {
  projectId: string;
  teamId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const busyRef = useRef(false);

  // Lazy load: mark loading synchronously from the event handler (not
  // inside the effect — synchronous setState in an effect body is a
  // cascade-render lint error; same pattern as ProjectTimelinePanel).
  const toggle = () => {
    if (!open) setState({ kind: 'loading' });
    setOpen((v) => !v);
  };

  // First load on open + poll while open. Data fetching is a pure async
  // function (module scope); setState only happens inside the .then/.catch
  // callbacks — the same "subscribe to an external system" shape the
  // react-hooks lint rule expects (and ProjectTimelinePanel uses).
  useEffect(() => {
    if (!open) return;
    const signal = { stopped: false };
    const run = () => {
      if (busyRef.current) return;
      busyRef.current = true;
      fetchAllProjectEvents(projectId, teamId, signal)
        .then((result) => {
          if (signal.stopped) return;
          if (result.kind === 'ok') {
            setState({ kind: 'ok', events: result.events, truncated: result.truncated });
          } else if (result.kind === 'not-deployed') {
            setState({ kind: 'not-deployed' });
          } else {
            setState({ kind: 'error', message: result.message });
          }
        })
        .catch((e: unknown) => {
          if (signal.stopped) return;
          setState({ kind: 'error', message: loadErrorMessage(e, '事件流加载失败') });
        })
        .finally(() => {
          busyRef.current = false;
        });
    };
    run();
    const timer = window.setInterval(run, POLL_MS);
    return () => {
      signal.stopped = true;
      window.clearInterval(timer);
    };
  }, [open, projectId, teamId]);

  // Newest first (the API pages are oldest first).
  const shown =
    state.kind === 'ok' ? [...state.events].reverse() : [];

  let listBody: ReactNode = <span className="text-muted-foreground">加载中…</span>;
  if (state.kind === 'error') {
    listBody = <span className="text-muted-foreground">{state.message}</span>;
  } else if (state.kind === 'not-deployed') {
    listBody = (
      <span className="text-muted-foreground">
        事件流端点未部署——Controller 升级到含任务状态转换引擎（上游 #1233）的版本后这里会聚合
      </span>
    );
  } else if (state.kind === 'ok' && shown.length === 0) {
    listBody = (
      <span className="text-muted-foreground">
        暂无转换事件——Agent 执行任务（delegate/ack/submit/report_progress）后这里会聚合
      </span>
    );
  } else if (state.kind === 'ok') {
    listBody = (
      <>
        {state.truncated ? (
          <div className="text-amber-600 dark:text-amber-400">
            更早事件超出 2000 条窗口，仅显示最近部分
          </div>
        ) : null}
        {shown.map((ev, i) => (
          <div key={`${ev.seq ?? 'x'}-${ev.ts}-${ev.task_id}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="tabular-nums text-muted-foreground">
              {fmtEventTime(ev.ts)}
            </span>
            <span className="font-medium text-foreground">{ev.action}</span>
            <span className="whitespace-nowrap">
              <StatusSpan value={ev.from} />
              <span className="text-muted-foreground"> → </span>
              <StatusSpan value={ev.to} />
            </span>
            {ev.task_id ? (
              <span className="font-mono text-muted-foreground">{ev.task_id}</span>
            ) : null}
            {ev.actor ? (
              <span className="text-muted-foreground">
                by {ev.actor.split(':')[0].replace(/^@/, '')}
              </span>
            ) : null}
            {ev.note ? (
              <span className="max-w-[420px] truncate text-muted-foreground" title={ev.note}>
                {ev.note}
              </span>
            ) : null}
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="mt-3 rounded-md border p-3">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Activity className="h-3.5 w-3.5" />
        <span>事件流</span>
        {state.kind === 'ok' && shown.length > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs">{shown.length}</span>
        ) : null}
      </button>
      {open ? <div className="mt-2 space-y-1.5 overflow-y-auto pl-4 text-xs" style={{ maxHeight: 320 }}>{listBody}</div> : null}
    </div>
  );
}
