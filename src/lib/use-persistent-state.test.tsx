import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, render, screen } from '@testing-library/react';
import { usePersistentState } from '@/lib/use-persistent-state';

const KEYS = [
  'test-ps-basic',
  'test-ps-restore',
  'test-ps-invalid',
  'test-ps-corrupt',
  'test-ps-deeplink',
  'test-ps-nostorage',
];
const isOneOf = (allowed: string[]) => (raw: unknown): raw is string =>
  typeof raw === 'string' && allowed.includes(raw);

afterEach(() => {
  KEYS.forEach((k) => window.localStorage.removeItem(k));
});

describe('usePersistentState', () => {
  it('starts at the initial value when nothing is stored', () => {
    const { result } = renderHook(() =>
      usePersistentState<string>('test-ps-basic', 'kanban', isOneOf(['kanban', 'projects'])),
    );
    expect(result.current[0]).toBe('kanban');
  });

  it('restores a valid stored value after mount (SSR renders the default)', async () => {
    window.localStorage.setItem('test-ps-restore', JSON.stringify('projects'));
    const { result } = renderHook(() =>
      usePersistentState<string>('test-ps-restore', 'kanban', isOneOf(['kanban', 'projects'])),
    );
    await act(async () => {});
    expect(result.current[0]).toBe('projects');
  });

  it('ignores stored values that fail validation', async () => {
    window.localStorage.setItem('test-ps-invalid', JSON.stringify('grid'));
    const { result } = renderHook(() =>
      usePersistentState<string>('test-ps-invalid', 'kanban', isOneOf(['kanban', 'projects'])),
    );
    await act(async () => {});
    expect(result.current[0]).toBe('kanban');
  });

  it('ignores corrupt stored JSON', async () => {
    window.localStorage.setItem('test-ps-corrupt', '{{not json');
    const { result } = renderHook(() =>
      usePersistentState<string>('test-ps-corrupt', 'kanban', isOneOf(['kanban', 'projects'])),
    );
    await act(async () => {});
    expect(result.current[0]).toBe('kanban');
  });

  it('persists through the setter as JSON', () => {
    const { result } = renderHook(() =>
      usePersistentState<string>('test-ps-basic', 'kanban', isOneOf(['kanban', 'projects'])),
    );
    act(() => result.current[1]('projects'));
    expect(result.current[0]).toBe('projects');
    expect(window.localStorage.getItem('test-ps-basic')).toBe('"projects"');
  });

  it('supports null values (explicit "no selection")', () => {
    const { result } = renderHook(() =>
      usePersistentState<string | null>('test-ps-basic', null, (raw): raw is string | null => raw === null || typeof raw === 'string'),
    );
    act(() => result.current[1]('proj-1'));
    expect(window.localStorage.getItem('test-ps-basic')).toBe('"proj-1"');
    act(() => result.current[1](null));
    expect(window.localStorage.getItem('test-ps-basic')).toBe('null');
  });

  it('still updates state when storage writes throw', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() =>
      usePersistentState<string>('test-ps-nostorage', 'kanban', isOneOf(['kanban', 'projects'])),
    );
    expect(() => act(() => result.current[1]('projects'))).not.toThrow();
    expect(result.current[0]).toBe('projects');
    spy.mockRestore();
  });

  it('a value set before mount (deep link) wins over the stored preference', () => {
    // Stored preference from a previous visit…
    window.localStorage.setItem('test-ps-deeplink', JSON.stringify('proj-old'));
    // …but a pending project deep link (HITL inbox card) is consumed during
    // the first render, exactly like takePendingProjectKey() in
    // tasks-section: consumed once, so the guarded set converges.
    let pending: { id: string } | null = { id: 'proj-new' };
    function Probe() {
      const [sel, setSel] = usePersistentState<string | null>(
        'test-ps-deeplink',
        null,
        (raw): raw is string | null =>
          raw === null || (typeof raw === 'string' && raw.length > 0),
      );
      if (pending) {
        const dl = pending;
        pending = null;
        setSel(dl.id);
      }
      return <span data-testid="sel">{String(sel)}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('sel').textContent).toBe('proj-new');
  });
});
