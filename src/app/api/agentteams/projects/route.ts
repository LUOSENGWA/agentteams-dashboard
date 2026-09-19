import { NextRequest, NextResponse } from 'next/server';
import { getControllerUrl, proxyToAgentTeams } from '../proxy-helper';

export const dynamic = 'force-dynamic';

/**
 * Merge two controller project records that share one project_id.
 *
 * The controller lists one row per plan/mode record, and stale rows may carry
 * only partial fields (empty team_id / plan_type / mode). Merging must keep
 * the first non-empty value per field so the populated row wins while empty
 * rows still contribute any unique fields.
 */
function mergeProjectRecords(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const current = out[key];
    const currentEmpty = current === undefined || current === null || current === '';
    const valueEmpty = value === undefined || value === null || value === '';
    if (currentEmpty && !valueEmpty) out[key] = value;
  }
  return out;
}

/** Dedupe the controller project list by project_id (see mergeProjectRecords). */
function dedupeProjects(projects: unknown[]): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const entry of projects) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.project_id === 'string' ? record.project_id : '';
    // Records without an id cannot be merged safely — keep them as-is.
    const key = id || JSON.stringify(record);
    const prev = merged.get(key);
    merged.set(key, prev ? mergeProjectRecords(prev, record) : record);
  }
  return Array.from(merged.values());
}

// GET /api/agentteams/projects
//
// Proxies the AgentTeams controller project list endpoint
// (`GET /api/v1/projects`, introduced by agentteams/AgentTeams#1169).
//
// Query parameters are forwarded to the controller (notably `?team=`, which
// the W-PR-1 list endpoint supports), except the internal `controllerUrl`
// override consumed by getControllerUrl.
//
// The controller API may not be deployed yet (W-PR-1 not merged / controller
// not upgraded). In that case the upstream returns 404 and we degrade to an
// empty list with an `error` hint so the dashboard board still renders
// (the existing team-tasks board remains the fallback data source).
export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of search.entries()) {
    if (key === 'controllerUrl') continue; // internal override, not proxied
    params.append(key, value);
  }
  const qs = params.toString();
  const path = `/api/v1/projects${qs ? `?${qs}` : ''}`;

  const res = await proxyToAgentTeams(request, getControllerUrl(request), path, {
    forwardBody: false,
  });

  if (res.ok) {
    // Same project_id can appear once per plan/mode record (some rows with
    // only partial fields). Duplicates break the dashboard tree (duplicate
    // React keys → ghost rows), inflate kind counts, and make workflow
    // lookups ambiguous across teams — merge them before responding.
    try {
      const body = (await res.json()) as Record<string, unknown>;
      if (Array.isArray(body.projects)) {
        const projects = dedupeProjects(body.projects);
        return NextResponse.json(
          { ...body, projects, total: projects.length },
          { status: res.status },
        );
      }
      // Unexpected shape: body is already consumed — re-emit it as-is.
      return NextResponse.json(body, { status: res.status });
    } catch {
      // Non-JSON or unreadable body — fall through to the raw passthrough.
    }
    return res;
  }

  const status = res.status;
  let error = `HTTP ${status}`;
  try {
    const body = await res.json();
    // Controller errors use `{ message }` (httputil.ErrorResponse); accept
    // `{ error }` too for middleware-shaped bodies.
    if (body && typeof body === 'object') {
      const b = body as { error?: unknown; message?: unknown };
      if (typeof b.message === 'string' && b.message) error = b.message;
      else if (typeof b.error === 'string' && b.error) error = b.error;
    }
  } catch {
    // non-JSON error body; keep the generic message
  }

  // Distinguish "API not deployed yet" (404 — W-PR-1 not merged / controller
  // not upgraded) from "controller endpoint exists but failed" (500+ — e.g.
  // MinIO unreachable). Both degrade to an empty list so the board still
  // renders, but the frontend can show a different hint for each.
  const degradedReason: 'api-not-deployed' | 'controller-error' =
    status >= 500 ? 'controller-error' : 'api-not-deployed';

  return NextResponse.json(
    {
      projects: [],
      total: 0,
      error,
      degraded: true,
      degradedReason,
    },
    { status: 200 },
  );
}
