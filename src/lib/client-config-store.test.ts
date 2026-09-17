import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_CONFIG_KEY,
  clearClientConfig,
  loadClientConfig,
  saveClientConfig,
  updateClientConfig,
  validateClientAddress,
} from './client-config-store';

beforeEach(() => {
  localStorage.clear();
});

describe('client config store (at_cfg, plugin config.json 1:1 mapping)', () => {
  it('returns null when unconfigured', () => {
    expect(loadClientConfig()).toBeNull();
  });

  it('round-trips the full config shape', () => {
    saveClientConfig({
      matrix_homeservers: ['http://10.0.0.10:6867', 'https://agentteams.example.com:6867'],
      controller_urls: ['http://10.0.0.10:8090'],
      controller_token: 'sa-token-123',
      sglang: { enabled: true, urls: ['http://10.0.0.10:30000'] },
    });
    const cfg = loadClientConfig();
    expect(cfg).toEqual({
      matrix_homeservers: ['http://10.0.0.10:6867', 'https://agentteams.example.com:6867'],
      controller_urls: ['http://10.0.0.10:8090'],
      controller_token: 'sa-token-123',
      sglang: { enabled: true, urls: ['http://10.0.0.10:30000'] },
    });
  });

  it('tolerates a corrupted / partial stored value (defaults fill gaps)', () => {
    localStorage.setItem(CLIENT_CONFIG_KEY, '{"matrix_homeservers":"not-an-array","controller_token":42}');
    const cfg = loadClientConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.matrix_homeservers).toEqual([]);
    expect(cfg!.controller_token).toBe('');
    expect(cfg!.sglang).toEqual({ enabled: false, urls: [] });
  });

  it('tolerates invalid JSON (returns null, never throws)', () => {
    localStorage.setItem(CLIENT_CONFIG_KEY, '{broken');
    expect(loadClientConfig()).toBeNull();
  });

  it('filters empty / whitespace entries from address lists', () => {
    saveClientConfig({
      matrix_homeservers: ['http://a:1', '', '   ', 'http://b:2'],
      controller_urls: ['http://c:3'],
      controller_token: '',
      sglang: { enabled: false, urls: [] },
    });
    expect(loadClientConfig()!.matrix_homeservers).toEqual(['http://a:1', 'http://b:2']);
  });

  it('updateClientConfig merges on top of the current value', () => {
    saveClientConfig({
      matrix_homeservers: ['http://a:1'],
      controller_urls: ['http://c:3'],
      controller_token: 'keep-me',
      sglang: { enabled: true, urls: ['http://s:30000'] },
    });
    const next = updateClientConfig({ controller_urls: ['http://d:4'] });
    expect(next.matrix_homeservers).toEqual(['http://a:1']);
    expect(next.controller_urls).toEqual(['http://d:4']);
    expect(next.controller_token).toBe('keep-me');
    expect(next.sglang).toEqual({ enabled: true, urls: ['http://s:30000'] });

    const merged = updateClientConfig({ sglang: { urls: [] } });
    expect(merged.sglang).toEqual({ enabled: true, urls: [] });
  });

  it('updateClientConfig from empty produces defaults + the patch', () => {
    const next = updateClientConfig({ matrix_homeservers: ['http://a:1'] });
    expect(next.controller_token).toBe('');
    expect(next.controller_urls).toEqual([]);
    expect(loadClientConfig()!.matrix_homeservers).toEqual(['http://a:1']);
  });

  it('clearClientConfig removes the entry', () => {
    saveClientConfig({
      matrix_homeservers: ['http://a:1'],
      controller_urls: [],
      controller_token: 'x',
      sglang: { enabled: false, urls: [] },
    });
    clearClientConfig();
    expect(loadClientConfig()).toBeNull();
  });
});

describe('validateClientAddress', () => {
  it('accepts plain http/https addresses', () => {
    expect(validateClientAddress('http://10.0.0.10:8090', 'controller')).toBeNull();
    expect(validateClientAddress('https://agentteams.example.com', 'matrix')).toBeNull();
    expect(validateClientAddress('http://sglang.local:30000', 'sglang')).toBeNull();
  });

  it('rejects non-URL input and non-http schemes', () => {
    expect(validateClientAddress('not a url', 'controller')).toBe('不是合法的 URL');
    expect(validateClientAddress('ftp://x:1', 'controller')).toContain('http/https');
  });

  it('rejects a path on a Matrix homeserver (copy/paste guard)', () => {
    expect(validateClientAddress('http://x:6867/_matrix/client', 'matrix')).toContain('根地址');
    expect(validateClientAddress('http://x:6867', 'matrix')).toBeNull();
  });
});
