// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentTeamsStore } from './agentteams-store';

/**
 * FUNC-03: the auto-reconnect timer must be running when the store mounts
 * already disconnected. The module-level subscription only fires on a
 * state TRANSITION, so without the module-init kick a fresh (or
 * rehydrated-offline) session would never reconnect.
 */
describe('agentteams-store auto-reconnect (FUNC-03)', () => {
  let checkConnectionMock: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    checkConnectionMock = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    // Initial shape: mounted already disconnected with auto-reconnect on.
    useAgentTeamsStore.setState({
      autoReconnect: true,
      isConnected: false,
      isChecking: false,
      settingsOpen: false,
      reconnectInterval: 1000,
      checkConnection: checkConnectionMock,
    });
  });

  afterEach(() => {
    // Turning reconnect off stops the module-level timer (subscription).
    useAgentTeamsStore.setState({ autoReconnect: false });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs the reconnect loop without any user interaction after mount', async () => {
    // No transition produced — the module-init kick already started the
    // timer. Advancing time alone must trigger connection checks.
    await vi.advanceTimersByTimeAsync(1100);
    expect(checkConnectionMock).toHaveBeenCalled();
  });

  it('keeps retrying on the configured interval', async () => {
    checkConnectionMock.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(1100);
    const first = checkConnectionMock.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkConnectionMock.mock.calls.length).toBeGreaterThan(first);
  });

  it('starts the loop when the user enables auto-reconnect on a disconnected store', async () => {
    useAgentTeamsStore.setState({ autoReconnect: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect(checkConnectionMock).not.toHaveBeenCalled();

    // Transition: reconnect enabled while still disconnected.
    useAgentTeamsStore.setState({ autoReconnect: true });
    await vi.advanceTimersByTimeAsync(1100);
    expect(checkConnectionMock).toHaveBeenCalled();
  });

  it('stops attempting once connected', async () => {
    await vi.advanceTimersByTimeAsync(1100);
    expect(checkConnectionMock).toHaveBeenCalled();

    // Connected → the subscription stops the timer.
    useAgentTeamsStore.setState({ isConnected: true });
    const callsAtConnect = checkConnectionMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(checkConnectionMock.mock.calls.length).toBe(callsAtConnect);
  });
});
