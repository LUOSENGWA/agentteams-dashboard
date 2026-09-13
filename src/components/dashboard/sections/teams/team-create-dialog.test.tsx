import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { TeamCreateDialog, parseWorkerNames } from './team-create-dialog';
import { buildWorkerMembers } from '@/lib/agentteams-api';
import type { WorkerResponse } from '@/lib/agentteams-api';

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

// shadcn Select → 原生 select（value 可选：MemberPicker 不传 value）
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (_v: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

const worker = (name: string, model?: string) =>
  ({ name, model }) as unknown as WorkerResponse;

const renderDialog = (
  value: Parameters<typeof TeamCreateDialog>[0]['value'],
  workers: WorkerResponse[],
) => {
  const onChange = vi.fn((_next: unknown) => {});
  const result = render(
    <TeamCreateDialog
      open
      value={value}
      onChange={(next) => onChange(next)}
      isPending={false}
      onOpenChange={() => {}}
      onSubmit={() => {}}
      workers={workers}
    />,
  );
  return { onChange, container: result.container };
};

describe('TeamCreateDialog (plugin parity: members come from existing Workers only)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('no free-text inputs for leader/workers (悬空引用在输入层不可能)', () => {
    renderDialog(
      { name: 't', leader: { name: '' } },
      [worker('lead-1'), worker('real-w')],
    );
    expect(screen.queryByPlaceholderText('leader-name')).toBeNull();
    expect(screen.queryByPlaceholderText('worker1, worker2 或 worker1，worker2')).toBeNull();
  });

  it('leader select offers only existing workers', () => {
    const { container } = renderDialog(
      { name: 't', leader: { name: '' } },
      [worker('lead-1'), worker('real-w', 'qwen')],
    );
    const leaderSelect = container.querySelectorAll('select')[0] as HTMLSelectElement;
    expect(Array.from(leaderSelect.options).map((o) => o.value)).toEqual(['lead-1', 'real-w']);
    // 选项标签 = 名字 + 现用模型（插件 workerOptionLabel 同构）
    expect(Array.from(leaderSelect.options).map((o) => o.textContent)).toEqual([
      'lead-1',
      'real-w（qwen）',
    ]);
  });

  it('leader selection → onChange receives leader name', () => {
    const { onChange, container } = renderDialog(
      { name: 't', leader: { name: '' } },
      [worker('lead-1'), worker('real-w')],
    );
    const leaderSelect = container.querySelectorAll('select')[0] as HTMLSelectElement;
    fireEvent.change(leaderSelect, { target: { value: 'lead-1' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ leader: { name: 'lead-1' } }),
    );
  });

  it('worker picker excludes the leader; select → chip + payload', () => {
    const { onChange, container } = renderDialog(
      { name: 't', leader: { name: 'lead-1' }, workerNames: [] },
      [worker('lead-1'), worker('real-w'), worker('real-w2')],
    );
    // DOM 顺序：Leader / Worker 名单
    const workerPicker = container.querySelectorAll('select')[1] as HTMLSelectElement;
    expect(Array.from(workerPicker.options).map((o) => o.value)).toEqual(['real-w', 'real-w2']);

    // 受控 value：选中只断言 onChange 载荷（chip 渲染依赖父组件回灌 value）
    fireEvent.change(workerPicker, { target: { value: 'real-w' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ workerNames: ['real-w'] }),
    );
  });

  it('no workers at all → hint instead of selects', () => {
    renderDialog({ name: 't', leader: { name: '' } }, []);
    expect(screen.getByText(/暂无 Worker/)).toBeInTheDocument();
  });

  it('name or leader missing → create disabled', () => {
    renderDialog({ name: '', leader: { name: '' } }, [worker('lead-1')]);
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
  });

  it('name + leader set → create enabled', () => {
    renderDialog({ name: 't', leader: { name: 'lead-1' } }, [worker('lead-1')]);
    expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
  });
});

describe('parseWorkerNames', () => {
  it('splits on CN/EN commas and keeps a trailing-comma parse stable', () => {
    expect(parseWorkerNames('worker1,')).toEqual(['worker1']);
    expect(parseWorkerNames('worker1，worker2 , worker3')).toEqual([
      'worker1',
      'worker2',
      'worker3',
    ]);
    expect(parseWorkerNames('')).toEqual([]);
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
