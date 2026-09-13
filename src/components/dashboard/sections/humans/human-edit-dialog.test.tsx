import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import {
  HumanEditDialog,
  buildHumanUpdatePayload,
  type HumanEditDraft,
} from './human-edit-dialog';
import type { HumanResponse } from '@/lib/agentteams-api';

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (_v: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)} data-testid="level-select">
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>level</span>,
}));

const baseHuman: HumanResponse = {
  name: 'alice',
  phase: 'Active',
  displayName: 'Alice',
  matrixUserID: '@alice:node1',
  initialPassword: '',
  rooms: [],
  message: '',
  permissionLevel: 2,
  accessibleTeams: ['biz-team'],
  accessibleWorkers: ['w1'],
};

const draft = (overrides: Partial<HumanEditDraft> = {}): HumanEditDraft => ({
  displayName: baseHuman.displayName,
  email: '',
  permissionLevel: 2,
  accessibleTeams: 'biz-team',
  accessibleWorkers: 'w1',
  note: '',
  ...overrides,
});

const renderDialog = (props?: {
  human?: HumanResponse | null;
  teams?: string[];
  workers?: string[];
  isPending?: boolean;
}) => {
  const onSubmit = vi.fn((_payload?: unknown) => {});
  const human = props?.human ?? baseHuman;
  const teams = props?.teams ?? ['biz-team'];
  const workers = props?.workers ?? ['w1'];
  const isPending = props?.isPending ?? false;
  render(
    <HumanEditDialog
      human={human}
      teams={teams}
      workers={workers}
      isPending={isPending}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit };
};

describe('buildHumanUpdatePayload (merge-patch diff, #1209 semantics)', () => {
  it('unchanged draft → empty payload (nothing sent, nothing clobbered)', () => {
    expect(buildHumanUpdatePayload(baseHuman, draft())).toEqual({});
  });

  it('changed level → only the level key', () => {
    expect(buildHumanUpdatePayload(baseHuman, draft({ permissionLevel: 3 }))).toEqual({
      permissionLevel: 3,
    });
  });

  it('cleared teams → explicit empty list (present = clear, not unchanged)', () => {
    expect(buildHumanUpdatePayload(baseHuman, draft({ accessibleTeams: '' }))).toEqual({
      accessibleTeams: [],
    });
  });

  it('whitespace/separator differences are not changes (parsed comparison)', () => {
    expect(buildHumanUpdatePayload(baseHuman, draft({ accessibleTeams: ' biz-team ,  ' }))).toEqual({});
  });

  it('missing level field falls back to 1 (HumanResponse.permissionLevel is optional)', () => {
    const { permissionLevel: _drop, ...rest } = baseHuman;
    const noLevel = rest as HumanResponse;
    expect(buildHumanUpdatePayload(noLevel, draft({ permissionLevel: 2 }))).toEqual({
      permissionLevel: 2,
    });
  });
});

describe('HumanEditDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('missing team → red warning and save blocked (pre-flight for the server 400)', () => {
    renderDialog({ human: { ...baseHuman, accessibleTeams: ['ghost-team'] }, teams: ['biz-team'] });
    expect(screen.getByText(/以下团队不存在/)).toHaveTextContent('ghost-team');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('missing worker → red warning and save blocked', () => {
    renderDialog({
      human: { ...baseHuman, accessibleWorkers: ['ghost-w'] },
      workers: ['w1'],
    });
    expect(screen.getByText(/以下 Workers 不存在/)).toHaveTextContent('ghost-w');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('no changes → save disabled', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('level change → save enabled, onSubmit receives the minimal diff', () => {
    const { onSubmit } = renderDialog();
    fireEvent.change(screen.getByTestId('level-select'), { target: { value: '3' } });
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onSubmit).toHaveBeenCalledWith({ permissionLevel: 3 });
  });
});
