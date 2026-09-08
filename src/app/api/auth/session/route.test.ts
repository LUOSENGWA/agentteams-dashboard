// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import {
  SESSION_COOKIE_NAME,
  __resetSessionStoreForTests,
  createSession,
} from '@/lib/dashboard-session';

const SECRET = 'a1'.repeat(32);

function requestWith(cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest('http://dashboard.test/api/auth/session', { headers });
}

describe('GET /api/auth/session (M19 dashboard session)', () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    process.env.DASHBOARD_SESSION_SECRET = SECRET;
  });

  afterEach(() => {
    __resetSessionStoreForTests();
    delete process.env.DASHBOARD_SESSION_SECRET;
  });

  it('reports unauthenticated without a session cookie', async () => {
    const data = await (await GET(requestWith())).json();
    expect(data).toEqual({ authenticated: false });
  });

  it('reports the L1 (Console) session as level 3 / higress mode', async () => {
    const { cookieValue } = createSession({ user: 'luo', crLevel: 1, credential: { kind: 'sa' } });
    const data = await (await GET(requestWith(`${SESSION_COOKIE_NAME}=${cookieValue}`))).json();
    expect(data).toEqual({ authenticated: true, username: 'luo', level: 3, mode: 'higress' });
  });

  it('reports the L2 (Matrix) session as level 2 / matrix mode with the human name', async () => {
    const { cookieValue } = createSession({
      user: 'sunzong',
      crLevel: 2,
      teams: ['biz-team'],
      credential: { kind: 'matrix', token: 'syt_secret' },
    });
    const res = await GET(requestWith(`${SESSION_COOKIE_NAME}=${cookieValue}`));
    const data = await res.json();
    expect(data).toEqual({ authenticated: true, username: 'sunzong', level: 2, mode: 'matrix' });
    // The Matrix token must never leave the server.
    expect(JSON.stringify(data)).not.toContain('syt_secret');
  });

  it('ignores unrelated cookies (no session cookie present)', async () => {
    const data = await (await GET(requestWith('_hi_sess=abc'))).json();
    expect(data).toEqual({ authenticated: false });
  });
});
