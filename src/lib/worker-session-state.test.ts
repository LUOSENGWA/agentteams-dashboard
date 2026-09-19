import { describe, expect, it } from 'vitest';
import { deriveWorkerSessionState, DONE_DECAY_MS } from './worker-session-state';

const NOW = 1_700_000_000_000;

describe('deriveWorkerSessionState', () => {
  it('running heartbeat beats everything (unbounded, no 120s ceiling)', () => {
    expect(
      deriveWorkerSessionState({
        agentStatus: { agentStatus: 'running', runningTaskCount: 1 },
        isTyping: false,
        lastMessageTs: NOW - DONE_DECAY_MS - 60_000, // even long-past
        now: NOW,
      }),
    ).toBe('running');
  });

  it('runningTaskCount>0 alone means running (older payload without agentStatus)', () => {
    expect(
      deriveWorkerSessionState({
        agentStatus: { runningTaskCount: 2 },
        isTyping: false,
        now: NOW,
      }),
    ).toBe('running');
  });

  it('typing implies running when heartbeat is idle/absent', () => {
    expect(
      deriveWorkerSessionState({
        agentStatus: { agentStatus: 'idle' },
        isTyping: true,
        now: NOW,
      }),
    ).toBe('running');
  });

  it('recent lastFinishAt → done', () => {
    expect(
      deriveWorkerSessionState({
        agentStatus: { agentStatus: 'idle', lastFinishAt: new Date(NOW - 60_000).toISOString() },
        isTyping: false,
        now: NOW,
      }),
    ).toBe('done');
  });

  it('lastFinishAt older than the decay window → idle', () => {
    expect(
      deriveWorkerSessionState({
        agentStatus: { agentStatus: 'idle', lastFinishAt: new Date(NOW - DONE_DECAY_MS - 1).toISOString() },
        isTyping: false,
        now: NOW,
      }),
    ).toBe('idle');
  });

  it('falls back to last-message age when the controller has no heartbeat fields', () => {
    // No agentStatus at all (older controller) + a recent worker message → done.
    expect(
      deriveWorkerSessionState({ agentStatus: undefined, isTyping: false, lastMessageTs: NOW - 5_000, now: NOW }),
    ).toBe('done');
    // …and an old message → idle.
    expect(
      deriveWorkerSessionState({ agentStatus: undefined, isTyping: false, lastMessageTs: NOW - DONE_DECAY_MS - 1, now: NOW }),
    ).toBe('idle');
  });

  it('never running / done with no signals at all', () => {
    expect(deriveWorkerSessionState({ agentStatus: undefined, isTyping: false, now: NOW })).toBe('idle');
  });
});
