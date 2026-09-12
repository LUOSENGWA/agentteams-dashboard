// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { callHigressConsole } from '../app/api/higress/proxy-helper';
import { validateHigressSession } from './api-auth';

vi.mock('../app/api/higress/proxy-helper', () => ({
  callHigressConsole: vi.fn(),
}));

const mockCall = vi.mocked(callHigressConsole);

function requestWithCookie(cookie: string): NextRequest {
  return new NextRequest('http://dashboard.test/api/agentteams/teams', { headers: { cookie } });
}

describe('validateHigressSession (post-merge review Block 2 follow-up)', () => {
  beforeEach(() => {
    mockCall.mockReset();
  });

  it('never passes a consoleUrl — shared resolution, same Console URL as the login track', async () => {
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_URL', 'http://env-only.test:8001');
    mockCall.mockResolvedValueOnce({
      response: new Response(null, { status: 200 }),
      body: { name: 'admin', level: 1 },
    });

    const res = await validateHigressSession(requestWithCookie('_hi_sess=s1; ga=1'));

    expect(mockCall).toHaveBeenCalledTimes(1);
    const callArgs = mockCall.mock.calls[0]!;
    expect(callArgs[0]).toBe('/v1/consumers');
    const opts = callArgs[1];
    expect(opts).toMatchObject({ method: 'GET' });
    expect(opts?.cookie).toContain('_hi_sess=s1');
    // Block 2 follow-up: the raw env URL must no longer reach callHigressConsole —
    // URL resolution happens once inside via getHigressConsoleURL().
    expect(opts).not.toHaveProperty('consoleUrl');
    expect(res).toEqual({ valid: true, user: { name: 'admin', level: 1 } });
    vi.unstubAllEnvs();
  });

  it('non-ok Console response → invalid session', async () => {
    mockCall.mockResolvedValueOnce({
      response: new Response(null, { status: 401 }),
      body: null,
    });
    const res = await validateHigressSession(requestWithCookie('_hi_sess=s2'));
    expect(res).toEqual({ valid: false, user: null });
  });

  it('no Higress session cookie → short-circuit without calling the Console', async () => {
    const res = await validateHigressSession(requestWithCookie('ga=1; other=2'));
    expect(res).toEqual({ valid: false, user: null });
    expect(mockCall).not.toHaveBeenCalled();
  });
});
