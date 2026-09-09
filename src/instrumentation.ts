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
  const { startAddressProbe } = await import('./lib/address-probe');
  startAddressProbe();
}
