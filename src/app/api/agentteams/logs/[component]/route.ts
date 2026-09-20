import { NextRequest, NextResponse } from 'next/server';
import { getAuthToken, getControllerUrl } from '../../proxy-helper';
import { enforceLevelOnlyRbac } from '@/lib/server-auth';
import type { LogLine } from '@/lib/agentteams-api';

const DEFAULT_TAIL = 500;
const MAX_TAIL = 10000;

// SEC-07: container names are resolved from a fixed component whitelist.
// Arbitrary names would let any authenticated session read the Docker logs
// of unrelated containers on the host via the controller's Docker proxy.
const KNOWN_COMPONENT_CONTAINERS: Record<string, string> = {
  controller: 'agentteams-controller',
  manager: 'agentteams-manager',
  matrix: 'agentteams-controller', // embedded mode: all three run inside
  minio: 'agentteams-controller', // the controller container
  higress: 'agentteams-controller',
};

function resolveContainerName(component: string): string | null {
  return KNOWN_COMPONENT_CONTAINERS[component] ?? null;
}

function parseDockerLogs(buffer: ArrayBuffer, component: string): LogLine[] {
  const view = new DataView(buffer);
  const decoder = new TextDecoder('utf-8');
  const lines: LogLine[] = [];
  let offset = 0;

  while (offset + 8 <= view.byteLength) {
    const streamType = view.getUint8(offset);
    // bytes 1-3 are padding
    const length = view.getUint32(offset + 4, false); // big-endian
    if (length < 0 || offset + 8 + length > view.byteLength) break;

    const payload = decoder.decode(new Uint8Array(buffer, offset + 8, length));
    const level = streamType === 2 ? 'error' : 'info';

    // Docker timestamps are RFC3339Nano, e.g. 2026-07-04T11:18:30.123456789Z
    const tsRegex = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s(.*)$/;

    payload.split('\n').forEach((raw) => {
      if (!raw) return;
      const match = raw.match(tsRegex);
      if (match) {
        lines.push({
          timestamp: match[1],
          level,
          component,
          message: match[2].trimEnd(),
        });
      } else {
        lines.push({
          timestamp: new Date().toISOString(),
          level,
          component,
          message: raw.trimEnd(),
        });
      }
    });

    offset += 8 + length;
  }

  return lines;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ component: string }> }
) {
  const { component } = await params;
  // SEC-07: host-level container logs are an admin-adjacent read (L3 only).
  // 'manage' = host/admin-adjacent read (Docker container logs): L3 only.
  // Observer/operator sessions must stay away from host-level log data.
  const rbacDenied = await enforceLevelOnlyRbac(request, 'manage', 'container-log', component);
  if (rbacDenied) return rbacDenied;

  const container = resolveContainerName(decodeURIComponent(component));
  if (!container) {
    return NextResponse.json(
      { error: `Unknown log component "${component}". Known: ${Object.keys(KNOWN_COMPONENT_CONTAINERS).join(', ')}` },
      { status: 404 }
    );
  }
  const tailParam = request.nextUrl.searchParams.get('tail');
  const tail = Math.min(
    Math.max(parseInt(tailParam || String(DEFAULT_TAIL), 10), 1),
    MAX_TAIL
  );

  try {
    const controllerUrl = getControllerUrl(request);
    const token = await getAuthToken();
    const target = new URL(
      `/docker/v1.41/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
      controllerUrl
    ).toString();

    const res = await fetch(target, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json(
        { error: `Docker API returned ${res.status}: ${text}` },
        { status: res.status }
      );
    }

    const buffer = await res.arrayBuffer();
    const lines = parseDockerLogs(buffer, component);
    return NextResponse.json(lines);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown log error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
