import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkerSkillAssign } from './worker-skill-assign';
import type { WorkerResponse } from '@/lib/agentteams-api';

// vi.mock 工厂会被提升到 import 之前，闭包只能引用 vi.hoisted 作用域
const mocks = vi.hoisted(() => ({
  updateWorker: vi.fn(),
  restartWorker: vi.fn(),
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
    restartWorker: (...args: unknown[]) => mocks.restartWorker(...args),
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
    mocks.restartWorker.mockResolvedValue({ success: true, note: '' });
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

  it('保存成功后基线归零：保存禁用 + 已保存徽章 + restartWorker 被调用', async () => {
    renderAssign(['skill-a']);
    fireEvent.click(screen.getByLabelText(/^skill-b/));
    fireEvent.click(screen.getByRole('button', { name: '保存分配' }));
    await waitFor(() => {
      expect(mocks.updateWorker).toHaveBeenCalledWith('w1', {
        skills: ['skill-a', 'skill-b'],
      });
    });
    await waitFor(() => {
      expect(screen.getByText('已保存（2 个技能）')).toBeInTheDocument();
    });
    expect(mocks.restartWorker).toHaveBeenCalledWith('w1');
    // 基线已切到刚提交的集合 → dirty 归零
    expect(screen.getByRole('button', { name: '保存分配' })).toBeDisabled();
  });

  it('保存后继续改选：徽章消失、保存按钮恢复，再保存提交新全集', async () => {
    renderAssign(['skill-a']);
    fireEvent.click(screen.getByLabelText(/^skill-b/));
    fireEvent.click(screen.getByRole('button', { name: '保存分配' }));
    await waitFor(() => {
      expect(screen.getByText('已保存（2 个技能）')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/^skill-c/));
    expect(screen.queryByText(/已保存（/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存分配' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '保存分配' }));
    await waitFor(() => {
      expect(mocks.updateWorker).toHaveBeenCalledWith('w1', {
        skills: ['skill-a', 'skill-b', 'skill-c'],
      });
    });
  });

  it('restart 失败 = 软失败：保存仍成功，琥珀提示重启未确认', async () => {
    mocks.restartWorker.mockRejectedValue(new Error('restart 500'));
    renderAssign(['skill-a']);
    fireEvent.click(screen.getByLabelText(/^skill-b/));
    fireEvent.click(screen.getByRole('button', { name: '保存分配' }));
    await waitFor(() => {
      expect(screen.getByText('已保存（2 个技能）')).toBeInTheDocument();
    });
    expect(screen.getByText(/restart 500/)).toBeInTheDocument();
    // 软失败不影响基线归零
    expect(screen.getByRole('button', { name: '保存分配' })).toBeDisabled();
  });
});
