// Worker session running indicator (A17) — pure frontend derivation,
// zero backend changes.
//
// Logic is a 1:1 port of the workbench plugin's workerSessionState
// (v1.51 design freeze, beta.12.4): same constants, same priority,
// same boundary values — one source of truth, two implementations.
//
// Data sources (both already ingested by the existing /sync loop):
//   useTypingStore.typingUsers[roomId]  — m.typing events (the worker
//   sends typing while processing, 25s keep-alive, hard 2min cap — a
//   long task >2min drops out of typing; the UI therefore expresses
//   "active processing within the last ~2 minutes")
//   useRoomMetaStore.meta[roomId].lastMessageTs — last message ts
//
// State machine (9/14 design freeze; palette:
//   blue = running (breathing) / green = finished / gray = no task):
//   running = the worker's MXID is in the room's typing[]
//   done    = not running and activity within the last 10 minutes
//   idle    = everything else
//
// done boundary semantics (1:1 rooms): lastMessageTs does not
// distinguish the sender — in the short window between "the user just
// sent a task" and "the worker starts typing" the dot may flash green
// briefly. Workers start typing on receipt (matrix_channel verified),
// so the window is tiny; accepted.
// Team rooms have no per-user last-sender data (zero-backend
// constraint) → team rooms only express running (a worker is typing),
// never done/idle (avoids human messages triggering green).

import type { WorkerSessionState, SessionRoomLike } from './worker-session-state-types';

/** done window: last activity ≤ 10min ago counts as "just finished". */
export const DONE_WINDOW_MS = 10 * 60 * 1000;
/** Aging tick: re-derive every 60s (the done→idle flip needs no new message). */
export const TICK_MS = 60 * 1000;

/** Per-worker three-state: derived across all rooms by worker MXID. */
export function workerSessionState(
  mxid: string | undefined,
  rooms: readonly SessionRoomLike[],
  now: number = Date.now(),
): WorkerSessionState {
  if (!mxid) return 'idle';
  for (const r of rooms) {
    if ((r.typing || []).includes(mxid)) return 'running';
  }
  for (const r of rooms) {
    if (
      r.lastMessageTs &&
      now - r.lastMessageTs <= DONE_WINDOW_MS &&
      r.memberIds &&
      r.memberIds.includes(mxid)
    ) {
      return 'done';
    }
  }
  return 'idle';
}

/**
 * Room-level: any worker typing in the room → running; else by the
 * room's last activity. For team rooms callers must treat the result
 * as running-only (never render done/idle — see the module header).
 */
export function roomWorkerState(
  room: SessionRoomLike,
  workerMxids: ReadonlySet<string>,
  now: number = Date.now(),
): WorkerSessionState {
  for (const m of room.typing || []) {
    if (workerMxids.has(m)) return 'running';
  }
  if (room.lastMessageTs && now - room.lastMessageTs <= DONE_WINDOW_MS) return 'done';
  return 'idle';
}

/**
 * Team-room running check only: true when any of the room's workers is
 * typing right now. Deliberately no done/idle (v1.51 decision).
 */
export function roomHasRunningWorker(
  room: SessionRoomLike,
  workerMxids: readonly string[] | undefined,
): boolean {
  if (!workerMxids || workerMxids.length === 0) return false;
  const set = new Set(workerMxids);
  return (room.typing || []).some((m) => set.has(m));
}

export type { WorkerSessionState, SessionRoomLike };
