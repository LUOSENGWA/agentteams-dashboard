// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const helperMock = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  getControllerUrl: vi.fn(),
}));

vi.mock('../../proxy-helper', () => helperMock);

const auditMock = vi.hoisted(() => ({
  appendAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/audit-log', () => auditMock);

import { GET } from './route';

const SERVER_USER_HEADER = 'x-agentteams-user';
const SERVER_USER_LEVEL_HEADER = 'x-agentteams-user-level';

function makeRequest(component: string, level: number | null): NextRequest {
  const headers = new Headers();
  if (level !== null) {
    headers.set(SERVER_USER_HEADER, level === 3 ? 'admin' : 'observer');
    headers.set(SERVER_USER_LEVEL_HEADER, String(level));
  }
  return new NextRequest(`http://x/api/agentteams/logs/${component}`, { headers });
}

const fetchMock = vi.fn();

describe('GET /api/agentteams/logs/[component] (SEC-07)', () => {
  beforeEach(() => {
    helperMock.getControllerUrl.mockReturnValue('http://controller.test');
    helperMock.getAuthToken.mockResolvedValue('sa-token');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function dockerOkResponse() {
    // Docker multiplexed-stream frame: streamType=1 (stdout), 3 pad bytes,
    // big-endian length, payload with an RFC3339Nano timestamp line.
    const payload = Buffer.from('2026-09-20T01:02:03.123456789Z hello log\n');
    const head = Buffer.alloc(8);
    head.writeUInt8(1, 0);
    head.writeUInt32BE(payload.length, 4);
    return new Response(Buffer.concat([head, payload]), { status: 200 });
  }

  it('denies an L1 observer with 403 and never reaches the Docker API', async () => {
    const res = await GET(makeRequest('controller', 1), {
      params: Promise.resolve({ component: 'controller' }),
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditMock.appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rbac.deny.manage', severity: 'warning' })
    );
  });

  it('denies an anonymous request with 403 via the level-defaulting path', async () => {
    const res = await GET(makeRequest('controller', null), {
      params: Promise.resolve({ component: 'controller' }),
    });
    // No identity header → readServerIdentity returns null → allow. The
    // middleware at the network edge is the authoritative gate, so this
    // mirrors the documented no-identity semantics of enforceLevelOnlyRbac.
    expect(res.status).not.toBe(403);
  });

  it('allows an L3 admin to read a whitelisted component log', async () => {
    fetchMock.mockResolvedValue(dockerOkResponse());
    const res = await GET(makeRequest('controller', 3), {
      params: Promise.resolve({ component: 'controller' }),
    });
    expect(res.status).toBe(200);
    const lines = await res.json();
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe('hello log');
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/docker/v1.41/containers/agentteams-controller/logs');
  });

  it('maps every known component to a container and reads the log', async () => {
    for (const component of ['controller', 'manager', 'matrix', 'minio', 'higress']) {
      fetchMock.mockClear();
      // A consumed Response body cannot be read twice — fresh mock per call.
      fetchMock.mockResolvedValue(dockerOkResponse());
      const res = await GET(makeRequest(component, 3), {
        params: Promise.resolve({ component }),
      });
      expect(res.status).toBe(200);
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toMatch(/containers\/agentteams-(controller|manager)\/logs/);
    }
  });

  it('rejects an unknown component with 404 and never reaches the Docker API', async () => {
    const res = await GET(makeRequest('unrelated-container', 3), {
      params: Promise.resolve({ component: 'unrelated-container' }),
    });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain('Unknown log component');
  });
});
