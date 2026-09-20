import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

describe('/api/agentteams/mode (F7 authMode + defaultHomeservers)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stateful (default): no defaultHomeservers field', async () => {
    vi.stubEnv('AGENTTEAMS_DEPLOYMENT_MODE', 'embedded');
    vi.stubEnv('DASHBOARD_STATELESS', '');
    const res = await GET();
    const data = await res.json();
    expect(data.authMode).toBe('stateful');
    expect(data.defaultHomeservers).toBeUndefined();
  });

  it('stateless: defaultHomeservers carries the server-side candidates', async () => {
    vi.stubEnv('AGENTTEAMS_DEPLOYMENT_MODE', 'embedded');
    vi.stubEnv('DASHBOARD_STATELESS', '1');
    vi.stubEnv('AGENTTEAMS_MATRIX_URL', 'http://10.0.0.5:6167');
    const res = await GET();
    const data = await res.json();
    expect(data.authMode).toBe('stateless');
    expect(Array.isArray(data.defaultHomeservers)).toBe(true);
    // the configured env address is a candidate; the in-cluster default is
    // always appended last (failover tail)
    expect(data.defaultHomeservers).toContain('http://10.0.0.5:6167');
    expect(data.defaultHomeservers).toContain('http://agentteams-controller:6167');
  });

  it('stateless: the in-cluster default alone is fine when nothing is configured', async () => {
    vi.stubEnv('AGENTTEAMS_DEPLOYMENT_MODE', 'embedded');
    vi.stubEnv('DASHBOARD_STATELESS', '1');
    const res = await GET();
    const data = await res.json();
    expect(data.defaultHomeservers).toContain('http://agentteams-controller:6167');
  });
});
