// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getHigressConsoleURL,
  HigressConsoleConfigurationError,
  validateHigressConsoleURL,
  isFallbackConfigWriteEnabled,
  prepareAiRoutePayload,
} from './proxy-helper';

describe('Higress Console proxy configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a configured Console URL with an exact allowed host', () => {
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'external');
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_URL', 'https://console.example.test/api');
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_ALLOWED_HOSTS', 'console.example.test');

    expect(getHigressConsoleURL()).toBe('https://console.example.test/api');
  });

  it('rejects a configured Console URL whose host is absent from the allowlist', () => {
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'external');
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_URL', 'https://console.example.test');
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_ALLOWED_HOSTS', 'other.example.test');

    expect(() => getHigressConsoleURL()).toThrow(HigressConsoleConfigurationError);
  });

  it('requires both Console configuration values in external mode', () => {
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'external');

    expect(() => getHigressConsoleURL()).toThrow('AGENTTEAMS_AI_GATEWAY_ADMIN_URL must be configured');

    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_URL', 'https://console.example.test');
    expect(() => getHigressConsoleURL()).toThrow('AGENTTEAMS_AI_GATEWAY_ADMIN_ALLOWED_HOSTS must list the Console host');
  });

  it('uses the Controller Console URL by default in direct mode', () => {
    expect(getHigressConsoleURL()).toBe('http://agentteams-controller:8001/');
  });

  it('rejects suffix matches and unsupported protocols', () => {
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_ALLOWED_HOSTS', 'console.example.test');

    expect(() => validateHigressConsoleURL('https://nested.console.example.test')).toThrow(HigressConsoleConfigurationError);
    expect(() => validateHigressConsoleURL('file:///tmp/console')).toThrow(HigressConsoleConfigurationError);
  });

  it('strips fallbackConfig unless the fixed Console capability is enabled', async () => {
    expect(isFallbackConfigWriteEnabled()).toBe(false);
    expect(prepareAiRoutePayload({ name: 'chat', fallbackConfig: { maxRetries: 2 } })).toEqual({ name: 'chat' });

    vi.stubEnv('AGENTTEAMS_HIGRESS_FALLBACK_CONFIG_WRITE_ENABLED', 'true');
    vi.resetModules();
    const helper = await import('./proxy-helper');
    expect(helper.isFallbackConfigWriteEnabled()).toBe(true);
    expect(helper.prepareAiRoutePayload({ name: 'chat', fallbackConfig: { maxRetries: 2 } })).toEqual({ name: 'chat', fallbackConfig: { maxRetries: 2 } });
  });
});

describe('getHigressConsoleURL: saved setup-page config (post-merge review Block 2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-cfg-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('saved higress-console wins over env and is authorized without an allowlist entry', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        backends: { 'higress-console': { internal: 'http://console.custom.test:8001' } },
      }),
    );
    vi.stubEnv('DASHBOARD_CONFIG_FILE', file);
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_URL', '');
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_ALLOWED_HOSTS', 'other.example.test'); // does NOT include the saved host

    expect(getHigressConsoleURL()).toBe('http://console.custom.test:8001/');
  });

  it('no saved config → env path unchanged (host still needs the allowlist)', () => {
    vi.stubEnv('DASHBOARD_CONFIG_FILE', path.join(dir, 'absent.json'));
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'external');
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_URL', 'https://console.example.test');
    vi.stubEnv('AGENTTEAMS_AI_GATEWAY_ADMIN_ALLOWED_HOSTS', 'other.example.test');

    expect(() => getHigressConsoleURL()).toThrow(HigressConsoleConfigurationError);
  });

  it('external mode WITHOUT any allowlist still accepts the saved host (trust checked before getAllowedHosts throws)', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        backends: { 'higress-console': { internal: 'http://console.custom.test:8001' } },
      }),
    );
    vi.stubEnv('DASHBOARD_CONFIG_FILE', file);
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'external');
    // no AGENTTEAMS_AI_GATEWAY_ADMIN_ALLOWED_HOSTS and no env URL:
    // getAllowedHosts() would throw — the saved host must be trusted first.
    expect(getHigressConsoleURL()).toBe('http://console.custom.test:8001/');
  });
});

describe('validateHigressConsoleURL: trusted-host ordering (Block 2 follow-up)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a trusted (saved) host is authorized even in external mode with no allowlist', () => {
    // getAllowedHosts() throws in external mode without
    // AGENTTEAMS_AI_GATEWAY_ADMIN_ALLOWED_HOSTS — the saved-host trust must
    // complete before that throw, otherwise the saved host is never usable.
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'external');
    expect(
      validateHigressConsoleURL('http://saved.custom.test:8001', { trustedHosts: ['saved.custom.test'] }),
    ).toBe('http://saved.custom.test:8001/');
  });

  it('a non-trusted host still hits the external-mode allowlist requirement', () => {
    vi.stubEnv('AGENTTEAMS_HIGRESS_ADAPTER_MODE', 'external');
    expect(() =>
      validateHigressConsoleURL('http://other.example.test:8001', { trustedHosts: ['saved.custom.test'] }),
    ).toThrow(HigressConsoleConfigurationError);
  });
});
