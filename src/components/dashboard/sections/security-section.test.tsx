import { render, screen, within, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

vi.mock('@/hooks/use-agentteams-humans', () => ({ useHumans: vi.fn() }));
vi.mock('@/hooks/use-agentteams-workers', () => ({ useWorkers: vi.fn() }));
vi.mock('@/hooks/use-agentteams-teams', () => ({ useTeams: vi.fn() }));
vi.mock('@/hooks/use-agentteams-managers', () => ({ useManagers: vi.fn() }));
vi.mock('@/hooks/use-agentteams-infrastructure', () => ({ useInfrastructure: vi.fn() }));
vi.mock('@/lib/matrix-store', () => ({ useMatrixStore: vi.fn() }));
vi.mock('@/lib/agentteams-store', () => ({ useAgentTeamsStore: vi.fn() }));

import { useHumans } from '@/hooks/use-agentteams-humans';
import { useWorkers } from '@/hooks/use-agentteams-workers';
import { useTeams } from '@/hooks/use-agentteams-teams';
import { useManagers } from '@/hooks/use-agentteams-managers';
import { useInfrastructure } from '@/hooks/use-agentteams-infrastructure';
import { useMatrixStore } from '@/lib/matrix-store';
import { useAgentTeamsStore } from '@/lib/agentteams-store';
import { SecuritySection } from './security-section';

function makeHuman(name: string, level?: number) {
  return {
    name,
    displayName: name,
    permissionLevel: level,
    groupAllowFrom: [],
    accessibleTeams: [],
    accessibleWorkers: [],
  } as any;
}

function renderSection(humansList: ReturnType<typeof makeHuman>[]) {
  vi.mocked(useHumans).mockReturnValue({
    data: humansList,
    refetch: vi.fn(),
    isLoading: false,
  } as any);
  vi.mocked(useWorkers).mockReturnValue({ data: [], isLoading: false } as any);
  vi.mocked(useTeams).mockReturnValue({ data: [], isLoading: false } as any);
  vi.mocked(useManagers).mockReturnValue({ data: [], isLoading: false } as any);
  vi.mocked(useInfrastructure).mockReturnValue({ data: undefined, isLoading: false } as any);
  vi.mocked(useMatrixStore).mockReturnValue({ isLoggedIn: false, userId: undefined } as any);
  vi.mocked(useAgentTeamsStore).mockReturnValue({ isConnected: true } as any);
  render(<SecuritySection />);
}

// 用卡片内唯一的描述文本定位（卡片 badge 文本与 AccessMatrix 行 badge 重名，不能用）
const CARD_DESC = {
  l1: '等同 Admin：可访问所有房间、所有 Worker',
  l2: '指定团队 + 独立 Workers',
  l3: 'Worker 级（L3）：最低权限（含未设级别的 Human）',
} as const;

function cardOf(desc: string): HTMLElement {
  const el = screen.getByText(desc).closest('div[class*="p-3"]');
  if (!el) throw new Error(`card not found for ${desc}`);
  return el as HTMLElement;
}

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('SecuritySection 权限卡片与 permStats 归属一致（review #94 block）', () => {
  it('未设级别 Human 归 L3 卡，不进 L2 卡（controller L2 门 = 严格 permissionLevel 2）', () => {
    renderSection([makeHuman('alice', undefined), makeHuman('bob', 2)]);
    const l2 = within(cardOf(CARD_DESC.l2));
    const l3 = within(cardOf(CARD_DESC.l3));
    expect(l2.getByText('bob')).toBeInTheDocument();
    expect(l2.queryByText('alice')).not.toBeInTheDocument();
    expect(l3.getByText('alice')).toBeInTheDocument();
    expect(l3.queryByText('bob')).not.toBeInTheDocument();
  });

  it('permStats 与卡片归属一致：level 1/2/3/未设 → 管理员(1)、团队成员(1)、Worker(2)', () => {
    renderSection([
      makeHuman('a-admin', 1),
      makeHuman('b-member', 2),
      makeHuman('c-worker', 3),
      makeHuman('d-unset', undefined),
    ]);
    expect(
      screen.getByText((c) => c.includes('管理员(1)、团队成员(1)、Worker(2)')),
    ).toBeInTheDocument();
    // 卡片侧同口径：admin 1 人 / member 1 人 / worker 卡 2 人（c + d）
    expect(within(cardOf(CARD_DESC.l1)).getByText('a-admin')).toBeInTheDocument();
    expect(within(cardOf(CARD_DESC.l2)).getByText('b-member')).toBeInTheDocument();
    const l3 = within(cardOf(CARD_DESC.l3));
    expect(l3.getByText('c-worker')).toBeInTheDocument();
    expect(l3.getByText('d-unset')).toBeInTheDocument();
  });

  it('L2 卡只收 level 2（level 3 与未设都不进）', () => {
    renderSection([makeHuman('x-worker', 3), makeHuman('y-unset', undefined), makeHuman('z-member', 2)]);
    const l2 = within(cardOf(CARD_DESC.l2));
    expect(l2.getByText('z-member')).toBeInTheDocument();
    expect(l2.queryByText('x-worker')).not.toBeInTheDocument();
    expect(l2.queryByText('y-unset')).not.toBeInTheDocument();
  });

  it('AccessMatrix 使用共享 shadcn Table 原语（UI-06 一致性回归）', () => {
    const { container } = (() => {
      renderSection([makeHuman('alice', 1), makeHuman('bob', 2), makeHuman('carol', 3)]);
      return { container: document.body };
    })();
    expect(container.querySelector('[data-slot="table"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="table-header"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="table-body"]')).toBeInTheDocument();
    // 三档权限行都渲染在共享表格里（badge 文本形如 "Level 2 · 指定团队"）
    const table = container.querySelector('[data-slot="table"]') as HTMLElement;
    expect(within(table).getByText((c) => c.startsWith('Level 1 ·'))).toBeInTheDocument();
    expect(within(table).getByText((c) => c.startsWith('Level 2 ·'))).toBeInTheDocument();
    expect(within(table).getByText((c) => c.startsWith('Level 3 ·'))).toBeInTheDocument();
  });
});
