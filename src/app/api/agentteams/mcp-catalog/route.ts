import { NextRequest } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../proxy-helper';

// MCP deployment catalog (Controller `GET /api/v1/mcp-servers`, upstream
// #1250) — read-only, includes per-server `workers[]` (which workers wire
// to it) and `source` (registry / worker-spec / both). This is the
// "who-is-wired" half of the MCP surface: the MinIO-based MCP registry
// (CRUD) does not carry wiring, so this Controller catalog is the
// authoritative source for the workers column.
//
// Older Controllers (predating the endpoint) return 404 → the UI hides
// the workers column (graceful).
export async function GET(request: NextRequest) {
  return proxyToAgentTeams(
    request,
    getControllerUrl(request),
    '/api/v1/mcp-servers',
    { forwardBody: false },
  );
}
