import { NextRequest } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../proxy-helper';

// Read-only model gateway route catalog (Controller
// `GET /api/v1/gateway/ai-routes`, upstream #1242, L1-only).
//
// This is the degraded read-only fallback for the Models tab when the
// Higress Console session is stale/absent: the route catalog is served by
// the Controller (token-authenticated, always available for L1), so the
// tab can still show what routes/providers/consumers are configured even
// when the Console session is down. CRUD still requires a live Console
// session. Older Controllers (predating the endpoint) return 404 → the UI
// hides the fallback panel.
export async function GET(request: NextRequest) {
  return proxyToAgentTeams(
    request,
    getControllerUrl(request),
    '/api/v1/gateway/ai-routes',
    { forwardBody: false },
  );
}
