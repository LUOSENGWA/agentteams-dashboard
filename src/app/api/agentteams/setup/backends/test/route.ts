// POST /api/agentteams/setup/backends/test — server-side probe of a
// user-supplied backend URL from the setup UI ("test connection" button).
//
// Public (pre-login) by design: this is the first-launch self-configuration
// flow. SSRF filter = DASHBOARD_ALLOWED_HOSTS (comma-separated hosts; empty
// = allow, which is fine for a local self-config tool — set it to pin
// targets in hardened deployments).
import { NextRequest, NextResponse } from 'next/server';
import {
  BACKEND_NAMES,
  forgetWorking,
  isHttpUrl,
  isTestTargetAllowed,
  markWorking,
  probeBackend,
  type BackendName,
} from '@/lib/backend-config';

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    backend?: unknown;
    url?: unknown;
  } | null;

  const backend = body?.backend;
  const url = body?.url;
  if (
    typeof backend !== 'string' ||
    !BACKEND_NAMES.includes(backend as BackendName) ||
    typeof url !== 'string' ||
    !isHttpUrl(url)
  ) {
    return NextResponse.json({ error: 'invalid-request' }, { status: 400 });
  }
  const name = backend as BackendName;
  const target = url.trim();

  if (!isTestTargetAllowed(target)) {
    return NextResponse.json({ error: 'host-not-allowed' }, { status: 403 });
  }

  const result = await probeBackend(name, target);
  // A successful explicit test records the address as working (user intent);
  // a failed test does NOT clear an existing working entry — the user may
  // have been testing an alternative that is down while the current one is
  // fine.
  if (result.ok) {
    markWorking(name, target);
  } else if (result.error === 'timeout' || result.error === 'fetch failed') {
    forgetWorking(name);
  }
  return NextResponse.json(result);
}
