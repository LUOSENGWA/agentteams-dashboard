// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';
import {
  SESSION_COOKIE_NAME,
  __resetSessionStoreForTests,
  createSession,
} from '@/lib/dashboard-session';

const SECRET = 'f'.repeat(64);

function dataRequest(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(`http://dashboard.test${path}`, { headers });
}

function l2Cookie(user = 'sunzong') {
  const { cookieValue } = createSession({
    user,
    crLevel: 2,
    teams: ['biz-team'],
    credential: { kind: 'matrix', token: 'syt_test' },
  });
  return cookieValue;
}

function l1Cookie() {
  const { cookieValue } = createSession({ user: 'luo', crLevel: 1, credential: { kind: 'sa' } });
  return cookieValue;
}

describe('middleware auth gate (M19 dashboard session)', () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    process.env.DASHBOARD_SESSION_SECRET = SECRET;
    delete process.env.AGENTTEAMS_AUTH_DISABLED;
  });

  afterEach(() => {
    __resetSessionStoreForTests();
    delete process.env.DASHBOARD_SESSION_SECRET;
    delete process.env.AGENTTEAMS_AUTH_DISABLED;
  });

  it('401 on /api/agentteams/* without a session cookie', async () => {
    const res = await middleware(dataRequest('/api/agentteams/teams'));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('401 on a forged (tampered) session cookie', async () => {
    const cookieValue = l2Cookie();
    const tampered = cookieValue.slice(0, -4) + 'xxxx';
    const res = await middleware(dataRequest('/api/agentteams/teams', `${SESSION_COOKIE_NAME}=${tampered}`));
    expect(res.status).toBe(401);
  });

  it('401 on a cookie from a destroyed session (restart semantics)', async () => {
    const { cookieValue } = createSession({ user: 'sunzong', crLevel: 2, credential: { kind: 'matrix', token: 't' } });
    __resetSessionStoreForTests(); // simulate container restart
    const res = await middleware(dataRequest('/api/agentteams/teams', `${SESSION_COOKIE_NAME}=${cookieValue}`));
    expect(res.status).toBe(401);
  });

  // Identity-header injection (x-agentteams-user/level) is asserted
  // end-to-end in proxy-helper.test.ts ("forwards the server-resolved
  // x-agentteams identity headers"); NextResponse.next does not expose the
  // overridden request headers on the response object.
  it('lets an L2 session through (gate open)', async () => {
    const res = await middleware(dataRequest('/api/agentteams/teams', `${SESSION_COOKIE_NAME}=${l2Cookie()}`));
    expect(res.status).toBe(200);
  });

  it('lets an L1 (Console) session through (gate open)', async () => {
    const res = await middleware(dataRequest('/api/agentteams/teams', `${SESSION_COOKIE_NAME}=${l1Cookie()}`));
    expect(res.status).toBe(200);
  });

  it('keeps the PUBLIC_PATHS escape (setup/status without a session)', async () => {
    const res = await middleware(dataRequest('/api/agentteams/setup/status'));
    expect(res.status).toBe(200);
  });

  it('keeps the AGENTTEAMS_AUTH_DISABLED escape hatch', async () => {
    process.env.AGENTTEAMS_AUTH_DISABLED = 'true';
    const res = await middleware(dataRequest('/api/agentteams/teams'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-agentteams-auth-mode')).toBe('disabled');
  });

  it('passes OPTIONS preflight through (no credentials on preflight)', async () => {
    const res = await middleware(new NextRequest('http://dashboard.test/api/agentteams/teams', { method: 'OPTIONS' }));
    expect(res.status).toBe(200);
  });

  it('redirects legacy /dashboard/ URLs to root', async () => {
    const res = await middleware(dataRequest('/dashboard/workers'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://dashboard.test/workers');
  });
});
