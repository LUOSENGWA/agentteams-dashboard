// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { nextIntervalMs, probeKinds } from './address-probe';

describe('probeKinds (plugin: single-address backends pay zero cost)', () => {
  it('only backends with >= 2 candidates are probed', () => {
    const kinds = probeKinds({
      controller: ['http://a', 'http://b'],
      matrix: ['http://a'],
      minio: ['http://a', 'http://b', 'http://c'],
      sglang: [],
      'higress-gateway': ['http://a'],
      'higress-console': [],
    });
    expect(kinds).toEqual(['controller', 'minio']);
  });

  it('no candidates at all → nothing to probe', () => {
    expect(probeKinds({})).toEqual([]);
  });
});

describe('nextIntervalMs (adaptive period, plugin 30/120/300s model)', () => {
  it('unsettled topology → fast (30s)', () => {
    expect(nextIntervalMs(false, 0)).toBe(30_000);
    expect(nextIntervalMs(false, 5)).toBe(30_000);
  });

  it('stable but not yet converged → base (120s)', () => {
    expect(nextIntervalMs(true, 0)).toBe(120_000);
    expect(nextIntervalMs(true, 1)).toBe(120_000);
  });

  it('two consecutive stable rounds → slow (300s)', () => {
    expect(nextIntervalMs(true, 2)).toBe(300_000);
    expect(nextIntervalMs(true, 5)).toBe(300_000);
  });
});
