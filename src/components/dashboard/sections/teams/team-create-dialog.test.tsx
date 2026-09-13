import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { TeamCreateDialog } from './team-create-dialog';
import { buildWorkerMembers } from '@/lib/agentteams-api';
import type { WorkerResponse } from '@/lib/agentteams-api';

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const baseValue = { name: '', leader: { name: 'lead-1' } };

describe('TeamCreateDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps a trailing English comma the user types in the worker input', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TeamCreateDialog open value={baseValue} onChange={onChange} isPending={false} onOpenChange={() => {}} onSubmit={() => {}} workers={[]} />,
    );

    const input = screen.getByPlaceholderText('worker1, worker2 或 worker1，worker2') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'worker1,' } });
    rerender(
      <TeamCreateDialog open value={{ ...baseValue, workerNames: ['worker1'] }} onChange={onChange} isPending={false} onOpenChange={() => {}} onSubmit={() => {}} workers={[]} />,
    );

    expect(input.value).toBe('worker1,');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ workerNames: ['worker1'] }));
  });
});

describe('TeamCreateDialog existence notice (creation = auto-provision)', () => {
  const worker = (name: string) => ({ name }) as unknown as WorkerResponse;

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('missing members → amber notice listing them (non-blocking: creation auto-provisions)', () => {
    render(
      <TeamCreateDialog
        open
        // name must be set: an empty team name independently disables submit
        value={{ ...baseValue, name: 'new-team', leader: { name: 'ghost-lead' }, workerNames: ['ghost-w', 'real-w'] }}
        onChange={() => {}}
        isPending={false}
        onOpenChange={() => {}}
        onSubmit={() => {}}
        workers={[worker('real-w')]}
      />,
    );
    const notice = screen.getByText(/以下成员尚不存在/);
    expect(notice).toHaveTextContent('ghost-lead');
    expect(notice).toHaveTextContent('ghost-w');
    expect(notice).not.toHaveTextContent('real-w');
    // auto-provisioning is designed behavior — submit stays enabled
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
  });

  it('all members exist → no notice', () => {
    render(
      <TeamCreateDialog
        open
        value={{ ...baseValue, workerNames: ['real-w'] }}
        onChange={() => {}}
        isPending={false}
        onOpenChange={() => {}}
        onSubmit={() => {}}
        workers={[worker('real-w'), worker('lead-1')]}
      />,
    );
    expect(screen.queryByText(/以下成员尚不存在/)).toBeNull();
  });
});

describe('buildWorkerMembers', () => {
  it('places the leader first as team_leader and dedupes members', () => {
    expect(buildWorkerMembers({ name: 'lead-1' }, ['worker-a', 'lead-1', 'worker-b'])).toEqual([
      { name: 'lead-1', role: 'team_leader' },
      { name: 'worker-a', role: 'worker' },
      { name: 'worker-b', role: 'worker' },
    ]);
  });

  it('returns an empty list when nothing is provided', () => {
    expect(buildWorkerMembers(undefined, undefined)).toEqual([]);
  });
});
