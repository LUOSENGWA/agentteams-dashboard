import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkerSkillAssign } from './worker-skill-assign';
import type { WorkerResponse } from '@/lib/agentteams-api';

// vi.mock 工厂会被提升到 import 之前，闭包只能引用 vi.hoisted 作用域
const mocks = vi.hoisted(() => ({
  updateWorker: vi.fn(),
  state: {
    catalog: null as { skills: unknown[]; total: number } | null,
  },
}));

const CATALOG = {
  skills: [
    { name: 'skill-a', description: '技能 A', source: 'custom', createdAt: '', updatedAt: '', fileCount: 1 },
    { name: 'skill-b', description: '技能 B', source: 'nacos', createdAt: '', updatedAt: '', fileCount: 1 },
    { name: 'skill-c', description: '', source: 'builtin', createdAt: '', updatedAt: '', fileCount: 1 },
  ],
  total: 3,
};

vi.mock('@/lib/agentteams-api', () => ({
  agentteamsApi: {
    updateWorker: (...args: unknown[]) => mocks.updateWorker(...args),
  },
}));

vi.mock('@/hooks/use-skill-center', () => ({
  useSkills: () => ({ data: mocks.state.catalog ?? { skills: [], total: 0 } }),
}));

function makeWorker(skills: string[]): WorkerResponse {
  return {
    name: 'w1',
    state: 'Running',
    runtime: 'qwenpaw',
    skills,
  } as unknown as WorkerResponse;
}

function renderAssign(skills: string[], onSaved?: () => void) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { throwOnError: false, retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <WorkerSkillAssign worker={makeWorker(skills)} onSaved={onSaved} />
    </QueryClientProvider>,
  );
}

describe('WorkerSkillAssign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.catalog = CATALOG;
    mocks.updateWorker.mockResolvedValue({});
  });
  afterEach(() => {
    cleanup();
  });

  it('目录渲染 + 存量技能预勾选，未改动时保存禁用', () => {
    renderAssign(['skill-a']);
    expect(screen.getByLabelText(/^skill-a/)).toBeChecked();
    expect(screen.getByLabelText(/^skill-b/)).not.toBeChecked();
    expect(screen.getByLabelText(/^skill-c/)).not.toBeChecked();
    expect(screen.getByRole('button', { name: '保存分配' })).toBeDisabled();
  });

  it('勾选新技能保存 = 全量替换（提交勾选全集）+ onSaved 回调', async () => {
    const onSaved = vi.fn();
    renderAssign(['skill-a'], onSaved);
    fireEvent.click(screen.getByLabelText(/^skill-b/));
    fireEvent.click(screen.getByRole('button', { name: '保存分配' }));
    await waitFor(() => {
      expect(mocks.updateWorker).toHaveBeenCalledWith('w1', {
        skills: ['skill-a', 'skill-b'],
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('不在目录的存量条目单列「不在目录」，取消勾选后从提交集中移除', async () => {
    renderAssign(['skill-a', 'nacos://ghost']);
    const stray = screen.getByLabelText(/nacos:\/\/ghost/);
    expect(stray).toBeChecked();
    expect(screen.getByText('不在目录')).toBeInTheDocument();
    fireEvent.click(stray);
    fireEvent.click(screen.getByRole('button', { name: '保存分配' }));
    await waitFor(() => {
      expect(mocks.updateWorker).toHaveBeenCalledWith('w1', { skills: ['skill-a'] });
    });
  });

  it('全选 / 清空快捷操作，清空后与空基线一致则保存禁用', async () => {
    renderAssign([]);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByLabelText(/^skill-c/)).toBeChecked();
    expect(screen.getByRole('button', { name: '保存分配' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(screen.getByLabelText(/^skill-a/)).not.toBeChecked();
    expect(screen.getByRole('button', { name: '保存分配' })).toBeDisabled();
  });

  it('目录为空且无存量技能 → 提示先上传', () => {
    mocks.state.catalog = { skills: [], total: 0 };
    renderAssign([]);
    expect(screen.getByText(/技能目录为空/)).toBeInTheDocument();
  });
});
