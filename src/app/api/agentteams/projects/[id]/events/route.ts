import { NextRequest } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../../proxy-helper';

export const dynamic = 'force-dynamic';

// GET /api/agentteams/projects/{id}/events
//
// Proxies the controller's task-transition event-stream endpoint
// (`GET /api/v1/projects/{id}/events`, merged upstream as PR #1233 —
// task state transition engine: table + history + events + progress).
//
// Query parameters are forwarded to the controller:
//   - `limit`  page size, 1..200 (controller default 50)
//   - `cursor` opaque pagination cursor (URL-safe string)
//   - `team`   (team, project_id) disambiguation for cross-team
//              duplicate project ids (bare id → 409)
// except the internal `controllerUrl` override consumed by
// getControllerUrl.
//
// Non-OK statuses pass through (404 project missing / endpoint not
// deployed yet — Controllers before #1233, 403 cross-team) so the
// frontend can render the "active after Controller upgrade"
// placeholder vs a real error.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const search = request.nextUrl.searchParams;
  const forwarded = new URLSearchParams();
  for (const [key, value] of search.entries()) {
    if (key === 'controllerUrl') continue; // internal override, not proxied
    forwarded.append(key, value);
  }
  const qs = forwarded.toString();
  const path = `/api/v1/projects/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ''}`;

  return proxyToAgentTeams(
    request,
    getControllerUrl(request),
    path,
    { forwardBody: false },
  );
}
