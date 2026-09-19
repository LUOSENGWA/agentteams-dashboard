/**
 * Worker session-state derivation (A17 — task status indicator).
 *
 * Three-state model, decided 9/14 (罗总 does not accept the 120s typing
 * ceiling): the *task-level* truth from the worker heartbeat
 * (`agentStatus`, merged upstream via the worker-agent-status PR) is
 * authoritative and unbounded; Matrix typing is the realtime fallback
 * (typing implies the worker is actively producing); a recent finish is
 * green and decays to idle after 10 minutes.
 *
 *   running  = agentStatus "running" / runningTaskCount>0 / typing now
 *   done     = finished (lastFinishAt or last message) within 10 min
 *   idle     = everything else
 *
 * On older controllers without the agentStatus fields the derivation
 * degrades gracefully to typing + last-message-age (never a fake "done"
 * beyond the 10-min decay).
 */
export type WorkerSessionState = 'running' | 'done' | 'idle';

export interface WorkerAgentStatusInfo {
  agentStatus?: string;
  runningTaskCount?: number;
  lastFinishAt?: string;
  lastRunAt?: string;
}

/** Window after which a "done" (green) dot decays to idle (gray). */
export const DONE_DECAY_MS = 10 * 60 * 1000;

export function deriveWorkerSessionState(opts: {
  agentStatus?: WorkerAgentStatusInfo | null;
  isTyping: boolean;
  /** Epoch ms of the worker's latest message in this room (0/undefined = none). */
  lastMessageTs?: number;
  now: number;
}): WorkerSessionState {
  const { agentStatus, isTyping, lastMessageTs, now } = opts;

  // 1) Task-level truth from the heartbeat — no time ceiling.
  if (
    agentStatus?.agentStatus === 'running' ||
    (agentStatus?.runningTaskCount ?? 0) > 0
  ) {
    return 'running';
  }
  // 2) Realtime typing signal — the worker is actively producing.
  if (isTyping) return 'running';
  // 3) Recently finished → green, decaying.
  const finishTs = agentStatus?.lastFinishAt
    ? Date.parse(agentStatus.lastFinishAt)
    : Number.NaN;
  const recentTs = Number.isFinite(finishTs) && finishTs > 0 ? finishTs : (lastMessageTs ?? 0);
  if (recentTs > 0 && now - recentTs < DONE_DECAY_MS) return 'done';
  return 'idle';
}
