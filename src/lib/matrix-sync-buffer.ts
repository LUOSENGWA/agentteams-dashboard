/**
 * Pending-event buffer + live-sync diagnostics for the Element-style
 * realtime chat pipeline.
 *
 * Why a buffer: the global /sync loop merges timeline events into the
 * react-query cache of rooms that are *already cached* (open, or visited
 * recently). When a room's message query has no cache yet (just opened,
 * or garbage-collected after `gcTime`), the events of that batch would
 * otherwise be silently dropped. They are buffered here (bounded, TTL'd)
 * and replayed by `useMatrixRoomMessages`' queryFn on the next fetch —
 * dedupe is by event_id inside `mergeTimelineEvents`, so the
 * merge-into-cache and buffer-replay paths can never double-count.
 */
import { useSyncExternalStore } from 'react';
import type { MatrixEvent } from '@/lib/matrix-api';

const BUFFER_CAP_PER_ROOM = 200;
const BUFFER_TTL_MS = 10 * 60 * 1000;

interface PendingRoom {
  events: MatrixEvent[];
  updatedAt: number;
}

const pending = new Map<string, PendingRoom>();

/** Queue timeline events for a room whose message cache does not exist yet. */
export function bufferSyncEvents(roomId: string, events: MatrixEvent[]): void {
  const now = Date.now();
  const room = pending.get(roomId);
  const eventsWithTs = events.filter(
    (e) => typeof e.origin_server_ts === 'number' && e.origin_server_ts > now - BUFFER_TTL_MS,
  );
  if (!eventsWithTs.length) return;
  const merged = room ? [...room.events, ...eventsWithTs] : eventsWithTs;
  pending.set(roomId, {
    events: merged.length > BUFFER_CAP_PER_ROOM ? merged.slice(-BUFFER_CAP_PER_ROOM) : merged,
    updatedAt: now,
  });
}

/**
 * Drain and return buffered events for a room (oldest first). Call from
 * the message queryFn after the server fetch, then merge — dedupe by
 * event_id makes replay idempotent.
 */
export function consumeBufferedEvents(roomId: string): MatrixEvent[] {
  const room = pending.get(roomId);
  if (!room) return [];
  pending.delete(roomId);
  return room.events;
}

/** Test-only: drop all buffered events. */
export function resetSyncBufferForTests(): void {
  pending.clear();
}

export interface SyncDiagnostics {
  /** Epoch ms of the last completed /sync batch (0 = never). */
  lastSyncAt: number;
  /** Epoch ms of the newest event seen through /sync (0 = none yet). */
  lastEventTs: number;
  /** Last /sync failure message (null while healthy). */
  error: string | null;
  /** Consecutive /sync failures. */
  failCount: number;
}

let diagnostics: SyncDiagnostics = {
  lastSyncAt: 0,
  lastEventTs: 0,
  error: null,
  failCount: 0,
};
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function recordSyncSuccess(eventTs: number): void {
  diagnostics = {
    lastSyncAt: Date.now(),
    lastEventTs: Math.max(diagnostics.lastEventTs, eventTs),
    error: null,
    failCount: 0,
  };
  emit();
}

export function recordSyncFailure(message: string): void {
  diagnostics = {
    ...diagnostics,
    error: message,
    failCount: diagnostics.failCount + 1,
  };
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): SyncDiagnostics {
  return diagnostics;
}

/** Live subscription to /sync health (chat header chip). */
export function useSyncDiagnostics(): SyncDiagnostics {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Coarse live status for the header chip:
 *  - `live`    = last batch < 45s (long-poll is 25s; one late batch OK)
 *  - `stale`   = a batch completed but > 45s ago
 *  - `error`   = consecutive failures (error non-null)
 *  - `idle`    = no batch yet
 */
export function syncStatusOf(
  d: SyncDiagnostics,
  now: number,
): 'live' | 'stale' | 'error' | 'idle' {
  if (d.error && d.failCount >= 2) return 'error';
  if (d.lastSyncAt === 0) return 'idle';
  return now - d.lastSyncAt < 45_000 ? 'live' : 'stale';
}
