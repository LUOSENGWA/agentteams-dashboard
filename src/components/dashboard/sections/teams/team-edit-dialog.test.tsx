import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { TeamEditDialog } from './team-edit-dialog';
import type { WorkerResponse } from '@/lib/agentteams-api';

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const worker = (name: string) => ({ name }) as unknown as WorkerResponse;

const renderDialog = (props: {
  value: Parameters<typeof TeamEditDialog>[0]['value'];
  workers?: WorkerResponse[];
  onSubmit?: () => void;
}) => {
  const onSubmit = vi.fn(props.onSubmit ?? (() => {}));
  render(
    <TeamEditDialog
      open
      teamName="sysdev"
      value={props.value}
      onChange={() => {}}
      isPending={false}
      onOpenChange={() => {}}
      onSubmit={() => onSubmit()}
      workers={props.workers ?? []}
    />,
  );
  return { onSubmit };
};

describe('TeamEditDialog existence guard', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('missing worker → red warning + save blocked (edit has no auto-provision)', () => {
    renderDialog({ value: { workerNames: ['ghost-w', 'real-w'] }, workers: [worker('real-w')] });
    expect(screen.getByText(/以下 Worker 不存在/)).toHaveTextContent('ghost-w');
    expect(screen.getByRole('button', { name: '更新' })).toBeDisabled();
  });

  it('all workers exist → save enabled and submits', () => {
    const { onSubmit } = renderDialog({
      value: { workerNames: ['real-w'] },
      workers: [worker('real-w')],
    });
    expect(screen.queryByText(/以下 Worker 不存在/)).toBeNull();
    const save = screen.getByRole('button', { name: '更新' });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onSubmit).toHaveBeenCalled();
  });

  it('empty member list → no warning, save enabled', () => {
    renderDialog({ value: { workerNames: [] }, workers: [worker('real-w')] });
    expect(screen.queryByText(/以下 Worker 不存在/)).toBeNull();
    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled();
  });
});
