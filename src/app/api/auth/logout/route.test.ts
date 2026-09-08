// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

describe('POST /api/auth/logout (M19)', () => {
  it('clears the dashboard session cookie', async () => {
    const res = await POST(new NextRequest('http://dashboard.test/api/auth/logout', { method: 'POST' }));
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('at_dash_sess=') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('also clears the Higress Console cookie when present', async () => {
    const request = new NextRequest('http://dashboard.test/api/auth/logout', {
      method: 'POST',
      headers: { cookie: 'at_dash_sess=x; _hi_sess=y' },
    });
    const res = await POST(request);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('_hi_sess=') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('does not emit a _hi_sess clear when that cookie is absent', async () => {
    const res = await POST(new NextRequest('http://dashboard.test/api/auth/logout', { method: 'POST' }));
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('_hi_sess='))).toBe(false);
  });
});

describe('POST /api/auth/logout server-side session destruction', () => {
  it('destroys the server-side session so the old cookie cannot be replayed', async () => {
    process.env.DASHBOARD_SESSION_SECRET = 'f'.repeat(64);
    const { createSession, validateSessionToken, SESSION_COOKIE_NAME, __resetSessionStoreForTests } =
      await import('@/lib/dashboard-session');
    __resetSessionStoreForTests();

    const { cookieValue } = createSession({
      user: 'sunzong',
      crLevel: 2,
      credential: { kind: 'matrix', token: 'syt_test' },
    });
    expect(validateSessionToken(cookieValue)).not.toBeNull();

    const request = new NextRequest('http://dashboard.test/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
    });
    const res = await POST(request);
    expect(res.status).toBe(200);
    expect(validateSessionToken(cookieValue)).toBeNull();

    delete process.env.DASHBOARD_SESSION_SECRET;
    __resetSessionStoreForTests();
  });
});
