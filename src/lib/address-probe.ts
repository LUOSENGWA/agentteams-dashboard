// Background address auto-rerank loop (port of the plugin's address_probe.py)
// — the "内外网自动探测" half of F1. The plugin probes on a QwenPaw host
// process; here it runs in the standalone dashboard server, started from the
// Next.js instrumentation hook (src/instrumentation.ts).
//
// - Only backends with >= 2 candidate addresses are probed — single-address
//   deployments pay zero cost (plugin rule, kept).
// - Adaptive period: 30s while the topology is unsettled (a switch just
//   happened, or some backend has no effective address), 120s normally, 300s
//   after 2 consecutive stable rounds (resource saver for steady networks).
// - 15s startup delay: don't fight the startup network window.
// - Reentrancy guard: a slow round never starts a second round.
// - Request-layer failover (proxy-helper) handles instant fallback; this loop
//   only optimizes the "slow but connected" case (latency fastest + hysteresis
//   via selectAndMark), so a network switch converges within one period.

import {
  BACKEND_NAMES,
  backendCandidatesSync,
  effectiveUrl,
  refreshEffective,
} from './backend-config';
import type { BackendName } from './backend-names';

const INTERVAL_FAST_MS = 30_000;
const INTERVAL_BASE_MS = 120_000;
const INTERVAL_STABLE_MS = 300_000;
const STABLE_ROUNDS = 2;
const STARTUP_DELAY_MS = 15_000;

/** Backends worth probing: >= 2 candidates (plugin: single-address users pay zero). */
export function probeKinds(candidates: Record<string, string[]>): BackendName[] {
  return BACKEND_NAMES.filter((n) => (candidates[n]?.length ?? 0) >= 2);
}

/** Adaptive period decision (plugin _probe_loop, extracted for unit tests). */
export function nextIntervalMs(stable: boolean, stableRounds: number): number {
  if (!stable) return INTERVAL_FAST_MS;
  if (stableRounds >= STABLE_ROUNDS) return INTERVAL_STABLE_MS;
  return INTERVAL_BASE_MS;
}

interface ProbeState {
  started: boolean;
  running: boolean;
  stableRounds: number;
  intervalMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

// globalThis-scoped on purpose (same lesson as the session store / working
// cache, 87cb478): Next may instantiate a server module more than once per
// process; a plain module-level flag would start one loop per instance.
function state(): ProbeState {
  const g = globalThis as unknown as { __dashboardAddressProbe?: ProbeState };
  if (!g.__dashboardAddressProbe) {
    g.__dashboardAddressProbe = {
      started: false,
      running: false,
      stableRounds: 0,
      intervalMs: INTERVAL_BASE_MS,
    };
  }
  return g.__dashboardAddressProbe;
}

export function stopAddressProbe(): void {
  const s = state();
  if (!s.started) return;
  s.started = false;
  if (s.timer) clearTimeout(s.timer);
  s.timer = undefined;
}

async function round(s: ProbeState): Promise<void> {
  if (s.running) return; // reentrancy guard (plugin _probe_loop)
  s.running = true;
  try {
    const candidates = Object.fromEntries(BACKEND_NAMES.map((n) => [n, backendCandidatesSync(n)]));
    const kinds = probeKinds(candidates);
    let stable = true;
    if (kinds.length > 0) {
      const { effective, switched } = await refreshEffective(kinds);
      const changed = kinds.filter((k) => switched[k]);
      if (changed.length > 0) {
        console.warn(
          `[dashboard] address auto-rerank: ${changed.map((k) => `${k} -> ${effectiveUrl(k)}`).join(', ')}`,
        );
      }
      // Round quality: every probed kind got an effective address this round.
      stable = kinds.every((k) => !!effective[k]);
    }
    s.stableRounds = stable ? s.stableRounds + 1 : 0;
    const next = nextIntervalMs(stable, s.stableRounds);
    if (next !== s.intervalMs) {
      console.warn(`[dashboard] address probe interval -> ${next / 1000}s (stable_rounds=${s.stableRounds})`);
      s.intervalMs = next;
    }
    s.timer = setTimeout(() => void round(s), next);
  } catch (err) {
    // A broken round must never kill the loop.
    console.warn('[dashboard] address probe round failed', err instanceof Error ? err.message : err);
    s.timer = setTimeout(() => void round(s), INTERVAL_FAST_MS);
  } finally {
    s.running = false;
  }
}

export function startAddressProbe(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  console.warn('[dashboard] address auto-rerank started (adaptive 30/120/300s; single-address backends skipped)');
  s.timer = setTimeout(() => void round(s), STARTUP_DELAY_MS);
}

/** Test hook: reset the globalThis singleton (tests only). */
export function __resetAddressProbeForTests(): void {
  const g = globalThis as unknown as { __dashboardAddressProbe?: ProbeState };
  if (g.__dashboardAddressProbe?.timer) clearTimeout(g.__dashboardAddressProbe.timer);
  delete g.__dashboardAddressProbe;
}
