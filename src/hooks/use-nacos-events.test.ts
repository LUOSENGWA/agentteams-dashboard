import { renderHook, act, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((_e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public _url: string) {
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

vi.stubGlobal('EventSource', MockEventSource);

import { useNacosEvents } from './use-nacos-events';

const INITIAL_DELAY = 5000;
const MAX_DELAY = 60_000;

function latest(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.instances = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useNacosEvents (FUNC-08)', () => {
  it('reconnects with exponential backoff capped at MAX_DELAY', () => {
    renderHook(() => useNacosEvents());
    expect(MockEventSource.instances).toHaveLength(1);

    // Failure chain: 5s → 10s → 20s → 40s → 60s(capped)
    act(() => latest().onerror?.());
    act(() => vi.advanceTimersByTime(INITIAL_DELAY - 1));
    expect(MockEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(MockEventSource.instances).toHaveLength(2);

    act(() => latest().onerror?.());
    act(() => vi.advanceTimersByTime(INITIAL_DELAY * 2 - 1));
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(MockEventSource.instances).toHaveLength(3);

    act(() => latest().onerror?.());
    act(() => vi.advanceTimersByTime(INITIAL_DELAY * 4 - 1));
    expect(MockEventSource.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(MockEventSource.instances).toHaveLength(4);

    act(() => latest().onerror?.());
    act(() => vi.advanceTimersByTime(INITIAL_DELAY * 8 - 1));
    expect(MockEventSource.instances).toHaveLength(4);
    act(() => vi.advanceTimersByTime(1));
    expect(MockEventSource.instances).toHaveLength(5);

    // Fifth failure schedules the 60s cap — 40s is not enough, 60s is.
    act(() => latest().onerror?.());
    act(() => vi.advanceTimersByTime(MAX_DELAY - 1));
    expect(MockEventSource.instances).toHaveLength(5);
    act(() => vi.advanceTimersByTime(1));
    expect(MockEventSource.instances).toHaveLength(6);
  });

  it('resets the backoff after a successful open', () => {
    renderHook(() => useNacosEvents());
    act(() => latest().onerror?.());
    act(() => vi.advanceTimersByTime(INITIAL_DELAY));
    expect(MockEventSource.instances).toHaveLength(2);

    // Successful connection resets the delay to INITIAL_DELAY.
    act(() => latest().onopen?.());
    act(() => latest().onerror?.());
    act(() => vi.advanceTimersByTime(INITIAL_DELAY));
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it('closes the latest EventSource on unmount and stops pending reconnects', () => {
    const { unmount } = renderHook(() => useNacosEvents());
    act(() => latest().onerror?.());
    // Reconnect timer pending; unmount must cancel it and close the closed-on-error source.
    unmount();
    expect(latest().closed).toBe(true);
    act(() => vi.advanceTimersByTime(MAX_DELAY * 2));
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('closes a reconnected instance created before unmount (cleanup race, FUNC-08)', () => {
    const { unmount } = renderHook(() => useNacosEvents());
    act(() => latest().onerror?.());
    act(() => vi.advanceTimersByTime(INITIAL_DELAY));
    expect(MockEventSource.instances).toHaveLength(2);
    // The second instance (created by the reconnect) must be the one closed.
    unmount();
    expect(MockEventSource.instances[1].closed).toBe(true);
    act(() => vi.advanceTimersByTime(MAX_DELAY * 2));
    expect(MockEventSource.instances).toHaveLength(2);
  });
});
