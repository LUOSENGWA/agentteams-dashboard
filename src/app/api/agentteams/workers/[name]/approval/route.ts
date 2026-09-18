import { NextRequest } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../../../proxy-helper';

// Worker approval level (Controller `GET/PUT /api/v1/workers/{name}/approval`,
// upstream #1216). Workers only (no manager endpoint). L2 users can read and
// set strict/smart/auto for own-team workers (off requires L1); team leaders
// are read-only.
//
// Status semantics (older / lower-privilege controllers degrade gracefully):
// - 200 → level returned / set
// - 404 → endpoint absent (older Controller) or worker outside team scope
//   (W8) → UI hides the section
// - 403 → no permission (L2 setting off, or team leader) → UI shows a notice
// - 409 → concurrent update conflict → retry
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  return proxyToAgentTeams(
    request,
    getControllerUrl(request),
    `/api/v1/workers/${encodeURIComponent(name)}/approval`,
    { forwardBody: false },
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  return proxyToAgentTeams(
    request,
    getControllerUrl(request),
    `/api/v1/workers/${encodeURIComponent(name)}/approval`,
    { forwardBody: true },
  );
}
