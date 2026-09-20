// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const packageMock = vi.hoisted(() => ({
  removePluginPackage: vi.fn(),
}));

vi.mock('@/lib/plugins/server-package', () => packageMock);

// SEC-08: Dashboard session + admin level (parity with the POST route).
const sessionMock = vi.hoisted(() => ({ getSessionFromRequest: vi.fn() }));

vi.mock('@/lib/dashboard-session', () => sessionMock);

import { NextRequest } from 'next/server';
import { DELETE } from './route';
import { PluginManifestError } from '@/lib/plugins/manifest';
import type { DashboardSession } from '@/lib/dashboard-session';

function makeSession(level: 1 | 2 | 3): DashboardSession {
  return {
    user: 'admin',
    level,
    credential: { kind: 'sa' },
    createdAt: Date.now(),
  } as DashboardSession;
}

function deleteRequest() {
  return new NextRequest('http://x/api/dashboard/plugins/alpha', { method: 'DELETE' });
}

describe('DELETE /api/dashboard/plugins/[id] (SEC-08 gate)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    sessionMock.getSessionFromRequest.mockReset();
  });

  it('rejects an anonymous request with 401', async () => {
    sessionMock.getSessionFromRequest.mockReturnValue(null);
    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ id: 'alpha' }) });
    expect(res.status).toBe(401);
    expect(packageMock.removePluginPackage).not.toHaveBeenCalled();
  });

  it('rejects a non-admin (L2) request with 403', async () => {
    sessionMock.getSessionFromRequest.mockReturnValue(makeSession(2));
    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ id: 'alpha' }) });
    expect(res.status).toBe(403);
    expect(packageMock.removePluginPackage).not.toHaveBeenCalled();
  });

  it('removes the package for an admin (L3) session', async () => {
    sessionMock.getSessionFromRequest.mockReturnValue(makeSession(3));
    packageMock.removePluginPackage.mockResolvedValue(undefined);
    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ id: 'alpha' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(packageMock.removePluginPackage).toHaveBeenCalledWith('alpha');
  });

  it('maps manifest errors to a 400', async () => {
    sessionMock.getSessionFromRequest.mockReturnValue(makeSession(3));
    packageMock.removePluginPackage.mockRejectedValue(new PluginManifestError('未知插件'));
    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ id: 'ghost' }) });
    expect(res.status).toBe(400);
  });
});
