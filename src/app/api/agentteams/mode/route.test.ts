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

  // Review pin: the payload is public (middleware PUBLIC_PATHS) — it must
  // never carry credential material, in any mode. Each secret env is stubbed
  // with a sentinel value and must stay out of the serialized body.
  it('payload leaks no secrets (stateful and stateless)', async () => {
    const secrets: Record<string, string> = {
      AGENTTEAMS_AUTH_TOKEN: 'sentinel-sa-token',
      AGENTTEAMS_AUTH_TOKEN_FILE: '/sentinel/token-file',
      AGENTTEAMS_FS_ACCESS_KEY: 'sentinel-fs-access-key',
      AGENTTEAMS_FS_SECRET_KEY: 'sentinel-fs-secret-key',
      AGENTTEAMS_LLM_API_KEY: 'sentinel-llm-api-key',
      AGENTTEAMS_MINIO_PASSWORD: 'sentinel-minio-password',
      DASHBOARD_SESSION_SECRET: 'sentinel-session-secret',
      DASHBOARD_SETUP_TOKEN: 'sentinel-setup-token',
      AGENTTEAMS_MATRIX_PASSWORD: 'sentinel-matrix-password',
    };
    for (const [k, v] of Object.entries(secrets)) vi.stubEnv(k, v);

    for (const stateless of ['', '1']) {
      vi.stubEnv('AGENTTEAMS_DEPLOYMENT_MODE', 'embedded');
      vi.stubEnv('DASHBOARD_STATELESS', stateless);
      const res = await GET();
      const text = JSON.stringify(await res.json());
      for (const [k, v] of Object.entries(secrets)) {
        expect(text, `${k} leaked into the public mode payload (authMode=${stateless ? 'stateless' : 'stateful'})`).not.toContain(v);
      }
      expect(text).not.toMatch(/token|secret|password|api[_-]?key/i);
    }
  });
});
