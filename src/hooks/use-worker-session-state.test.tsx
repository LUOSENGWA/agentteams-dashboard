import { renderHook, act, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { useSessionTick } from './use-worker-session-state';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useSessionTick (FUNC-09 shared ticker)', () => {
  it('creates a single module-level interval shared by all consumers', () => {
    const si = vi.spyOn(globalThis, 'setInterval');
    const a = renderHook(() => useSessionTick());
    const b = renderHook(() => useSessionTick());
    const intervalCalls = si.mock.calls.filter(([, ms]) => ms === 60_000);
    expect(intervalCalls).toHaveLength(1);
    a.unmount();
    b.unmount();
  });

  it('updates all consumers on the shared tick', () => {
    const a = renderHook(() => useSessionTick());
    const b = renderHook(() => useSessionTick());
    const before = a.result.current;
    expect(b.result.current).toBe(before);
    act(() => vi.advanceTimersByTime(60_000));
    expect(a.result.current).toBeGreaterThan(before);
    expect(b.result.current).toBe(a.result.current);
    a.unmount();
    b.unmount();
  });

  it('keeps ticking for remaining consumers after one unmounts', () => {
    const a = renderHook(() => useSessionTick());
    const b = renderHook(() => useSessionTick());
    a.unmount();
    const before = b.result.current;
    act(() => vi.advanceTimersByTime(60_000));
    expect(b.result.current).toBeGreaterThan(before);
    b.unmount();
  });

  it('clears the interval once the last consumer unmounts', () => {
    const ci = vi.spyOn(globalThis, 'clearInterval');
    const a = renderHook(() => useSessionTick());
    const b = renderHook(() => useSessionTick());
    a.unmount();
    expect(ci).not.toHaveBeenCalled();
    b.unmount();
    expect(ci).toHaveBeenCalled();
  });
});
