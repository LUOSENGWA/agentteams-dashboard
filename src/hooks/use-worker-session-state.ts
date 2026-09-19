'use client';

import { useEffect, useState } from 'react';
import { useWorkers } from '@/hooks/use-agentteams-workers';
import type { WorkerAgentStatusInfo } from '@/lib/worker-session-state';

/**
 * matrixUserID → runtime task-level status, from the polled worker list
 * (15s). Older controllers (no worker-agent-status fields) yield entries
 * with all fields undefined — the derivation then falls back to typing +
 * message age.
 */
export function useWorkerAgentStatusMap(): Record<string, WorkerAgentStatusInfo> {
  const { data: workers } = useWorkers();
  const map: Record<string, WorkerAgentStatusInfo> = {};
  for (const w of workers ?? []) {
    if (!w.matrixUserID) continue;
    map[w.matrixUserID] = {
      agentStatus: w.agentStatus,
      runningTaskCount: w.runningTaskCount,
      lastFinishAt: w.lastFinishAt,
      lastRunAt: w.lastRunAt,
    };
  }
  return map;
}

/**
 * Shared clock for the done→idle decay re-derivation (no network).
 * 5s granularity is enough for a 10-minute decay window.
 */
export function useSessionTick(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
