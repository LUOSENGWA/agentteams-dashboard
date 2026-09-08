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
