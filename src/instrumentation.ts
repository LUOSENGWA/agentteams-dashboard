// Next.js instrumentation hook (nodejs runtime): starts the background
// address auto-rerank loop when the standalone server boots — the dashboard
// equivalent of the plugin's register_startup_hook (address_probe.py).
//
// Skipped during `next build` (NEXT_PHASE set in the build worker) and in
// unit tests (VITEST), so the loop only runs in a live server process.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE) return;
  if (process.env.VITEST) return;
  const { isSharedMode } = await import('./lib/backend-config');
  // F1f-D: a shared (multi-user) deployment should NOT carry the cluster
  // super-credential in the env. L1 logs in via the per-login
  // controller-token paste (C2); L2 via pure Matrix (C3). The env token
  // stays readable at /proc/<pid>/env for every process in the container.
  if (isSharedMode() && (process.env.AGENTTEAMS_AUTH_TOKEN || '').trim()) {
    console.warn(
      '[dashboard] DASHBOARD_SHARED_MODE=1 but AGENTTEAMS_AUTH_TOKEN is set — ' +
        'a cluster-level super credential in the env. Drop it; L1 should use ' +
        'the controller-token paste at login instead.',
    );
  }
  const { startAddressProbe } = await import('./lib/address-probe');
  startAddressProbe();
}
