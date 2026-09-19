import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// 可变 holder：⑥ 号用例模拟轮询重取后列表顺序漂移（Controller 顺序不稳定）
const workersHolder = vi.hoisted(() => ({
  list: [
    { name: 'w1', team: 't1', role: 'team_leader' },
    { name: 'w2', team: 't2', role: 'worker' },
  ],
}));
vi.mock('@/hooks/use-agentteams-workers', () => ({
  useWorkers: () => ({
    data: workersHolder.list,
    isLoading: false,
    error: null,
  }),
}));

// MarkdownMessage 替身（避免拉聊天栈；断言透传 content）
vi.mock('@/components/dashboard/sections/chat/markdown-message', () => ({
  MarkdownMessage: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import { KnowledgeSection } from './knowledge-section';

const TREE_TOP = {
  directory: 'workspace',
  entries: [
    { kind: 'directory', name: 'memory', path: 'memory', size: null, modified_at: '', preview_kind: '' },
    { kind: 'directory', name: 'digest', path: 'digest', size: null, modified_at: '', preview_kind: '' },
    { kind: 'directory', name: 'nm-protocol', path: 'nm-protocol', size: null, modified_at: '', preview_kind: '' },
    { kind: 'file', name: 'MEMORY.md', path: 'MEMORY.md', size: 10, modified_at: '', preview_kind: 'markdown' },
    { kind: 'file', name: 'agent.json', path: 'agent.json', size: 20, modified_at: '', preview_kind: 'binary' },
  ],
  has_more: false,
  next_cursor: null,
};
const TREE_MEMORY = {
  directory: 'memory',
  entries: [
    { kind: 'file', name: 'a.md', path: 'memory/a.md', size: 10, modified_at: '', preview_kind: 'markdown' },
    { kind: 'file', name: 'b.md', path: 'memory/b.md', size: 10, modified_at: '', preview_kind: 'markdown' },
  ],
  has_more: false,
  next_cursor: null,
};
const TREE_DIGEST = { directory: 'digest', entries: [], has_more: false, next_cursor: null };

// a.md 链接 [[b]] 与 [[MEMORY]] → 每 Worker 2 条边
const CONTENTS: Record<string, string> = {
  'MEMORY.md': '# 总索引',
  'memory/a.md': 'see [[b]] and [[MEMORY]]',
  'memory/b.md': '',
};

function mockFetch(statuses?: { top?: number; memory?: number; digest?: number; content?: number; topError?: string }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = url as string;
      let status = 200;
      let body: unknown = {};
      if (u.includes('/tree')) {
        if (u.includes('path=memory')) { status = statuses?.memory ?? 200; body = TREE_MEMORY; }
        else if (u.includes('path=digest')) { status = statuses?.digest ?? 200; body = TREE_DIGEST; }
        else { status = statuses?.top ?? 200; body = TREE_TOP; }
      } else if (u.includes('/file-content')) {
        const m = u.match(/path=([^&]+)/);
        const p = m ? decodeURIComponent(m[1]) : '';
        status = statuses?.content ?? 200;
        body = { content: CONTENTS[p] ?? '', eof: true, offset: 0, next_offset: 0, etag: 'x' };
      }
      if (status >= 400 && statuses?.topError && u.includes('/tree') && !u.includes('path=memory') && !u.includes('path=digest')) {
        body = { error: statuses.topError };
      }
      return {
        ok: status < 400,
        status,
        headers: new Headers(),
        json: async () => body,
        blob: async () => new Blob([String(body)]),
      } as unknown as Response;
    }),
  );
}

/** 切 2D（jsdom 无 WebGL：默认 3D 视图先落降级横幅，点「回到 2D」） */
async function switchTo2D() {
  fireEvent.click(await screen.findByRole('button', { name: '回到 2D' }));
  return (await screen.findByRole('img', { name: /wikilink 图谱/ })) as unknown as { querySelectorAll: (_s: string) => NodeListOf<SVGElement> };
}

describe('KnowledgeSection（v3：3D / 预览与图谱分离 / 团队聚合 / 选择记忆）', () => {
  beforeEach(() => {
    vi.useRealTimers();
    workersHolder.list = [
      { name: 'w1', team: 't1', role: 'team_leader' },
      { name: 'w2', team: 't2', role: 'worker' },
    ];
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('① 顶层 404 → 显示服务端真实错误（容器/工作区缺失，非版本横幅）', async () => {
    mockFetch({ top: 404, topError: '容器 agentteams-worker-w1 不存在' });
    render(<KnowledgeSection />);
    expect(await screen.findByText(/容器 agentteams-worker-w1 不存在/)).toBeInTheDocument();
  });

  it('② 默认 3D：jsdom 无 WebGL → 降级横幅 + 一键回 2D（图谱不炸 tab）', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    expect(await screen.findByText(/3D 图谱不可用/)).toBeInTheDocument();
    expect(screen.getByText('已自动保留 2D 图谱视图')).toBeInTheDocument();
    const svg = await switchTo2D();
    const texts = Array.from(svg.querySelectorAll('text')).map((t) => t.textContent ?? '');
    expect(texts).toContain('MEMORY'); // MEMORY.md 干
    expect(texts).toContain('a');
    expect(texts).toContain('b');
    // a.md 链接 [[b]] 与 [[MEMORY]] → 2 条边
    expect(svg.querySelectorAll('line').length).toBe(2);
  });

  it('③ 点图谱节点 → 打开预览 且 图谱仍驻留（预览与图谱分离，回退不空白）', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    const svg = await switchTo2D();
    const nodeA = Array.from(svg.querySelectorAll('text')).find((t) => t.textContent === 'a')!;
    fireEvent.click(nodeA);
    // 预览卡更新
    expect(await screen.findByText('memory/a.md')).toBeInTheDocument();
    const md = await screen.findByTestId('md');
    expect(md.textContent).toBe('see [[b]] and [[MEMORY]]');
    // 图谱卡仍在（未切换视图、无空白态）
    expect(screen.getByRole('img', { name: /wikilink 图谱/ })).toBeInTheDocument();
    // 空预览提示消失
    expect(screen.queryByText(/点击左侧文件查看内容/)).not.toBeInTheDocument();
  });

  it('④ 四分类分组常驻左栏 + 展开 memory → 点文件预览（图谱卡并存）', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    await screen.findByText('知识文件');
    // 四分类分组头常驻（左栏文件树，无需切视图）
    expect(screen.getByText('档案')).toBeInTheDocument();
    expect(screen.getAllByText('文件', { selector: 'p' }).length).toBe(1);
    expect(screen.getByText('日记 memory')).toBeInTheDocument();
    expect(screen.getByText('知识库 digest')).toBeInTheDocument();
    // 档案=顶层 md（MEMORY.md 入档案组）；文件组=agent.json；顶层目录 nm-protocol 只列不展开
    expect(screen.getByText('MEMORY.md')).toBeInTheDocument();
    expect(screen.getByText('agent.json')).toBeInTheDocument();
    expect(screen.getByText('nm-protocol/')).toBeInTheDocument();
    // 展开 memory/ → 点 a.md 预览
    fireEvent.click(screen.getByText('memory/'));
    const fileBtn = await screen.findByText('a.md');
    fireEvent.click(fileBtn);
    expect(await screen.findByText('memory/a.md')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('md').textContent).toBe('see [[b]] and [[MEMORY]]'));
    // 图谱卡标题常驻
    expect(screen.getByText('知识图谱（wikilink 引用网络）')).toBeInTheDocument();
  });

  it('⑥ 默认 worker 钉住：轮询重取顺序漂移不重置视图（展开的目录保留）', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    const select = screen.getByRole('combobox', { name: /选择 Worker/ }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('w1')); // 首份列表钉住 w1
    // 展开 memory/（等文件树落地——顶层 fetch 是异步的）
    fireEvent.click(await screen.findByText('memory/'));
    await screen.findByText('a.md');
    // 轮询重取：列表顺序漂移（w2 变第一）+ 触发重渲染（折叠/展开图谱卡）
    workersHolder.list = [
      { name: 'w2', team: 't2', role: 'worker' },
      { name: 'w1', team: 't1', role: 'team_leader' },
    ];
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    await waitFor(() => expect(select.value).toBe('w1')); // 钉住不跟随 workers[0]
    expect(screen.getByText('a.md')).toBeInTheDocument(); // 展开状态保留
  });

  it('⑤ 团队透传：选择器按 team 分组（optgroup）+ 负责人标记', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    const select = screen.getByRole('combobox', { name: /选择 Worker/ }) as HTMLSelectElement;
    const groups = Array.from(select.querySelectorAll('optgroup'));
    expect(groups.map((g) => g.label)).toEqual(['t1', 't2']);
    const g1 = Array.from(groups[0].querySelectorAll('option'));
    expect(g1.map((o) => o.textContent)).toEqual(['w1 · 负责人']);
    const g2 = Array.from(groups[1].querySelectorAll('option'));
    expect(g2.map((o) => o.textContent)).toEqual(['w2']);
  });

  it('⑦ 团队聚合图谱：跨 Worker 合并建图 + 按 Worker 着色图例 + 聚合范围标注', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    expect(await screen.findByText('当前 Worker 图谱')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /团队聚合图谱/ }));
    // 聚合范围行（2 Workers）+ 聚合团队选择器（全部团队/t1/t2）
    expect(await screen.findByText('聚合 2 个 Worker')).toBeInTheDocument();
    const teamSel = screen.getByRole('combobox', { name: '聚合团队' }) as HTMLSelectElement;
    expect(Array.from(teamSel.options).map((o) => o.textContent)).toEqual([
      '全部团队（2 Workers）', 't1（1）', 't2（1）',
    ]);
    // 切 2D 断言合并图：w1+w2 各 3 文件 → 6 节点；各 2 边 → 4 边
    const svg = await switchTo2D();
    expect(svg.querySelectorAll('circle').length).toBe(6);
    expect(svg.querySelectorAll('line').length).toBe(4);
    // 图例=两个 Worker（按 Agent 着色）——option 文案带后缀/计数，图例为精确名
    expect(screen.getAllByText('w1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('w2').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('→ 引用方向')).not.toBeInTheDocument();
  });

  it('⑧ 选择记忆：worker 选择持久化 + 失效值回退（列表落地后校验）', async () => {
    mockFetch();
    window.localStorage.setItem('agentteams:kb:worker', 'w2');
    render(<KnowledgeSection />);
    const select = screen.getByRole('combobox', { name: /选择 Worker/ }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('w2')); // 记忆恢复
    // 手动切回 w1 → 持久化更新
    fireEvent.change(select, { target: { value: 'w1' } });
    expect(window.localStorage.getItem('agentteams:kb:worker')).toBe('w1');
  });

  it('⑨ 选择记忆：失效 worker（列表无此人）→ 回退默认推导，不卡死', async () => {
    mockFetch();
    window.localStorage.setItem('agentteams:kb:worker', 'ghost-worker');
    render(<KnowledgeSection />);
    const select = screen.getByRole('combobox', { name: /选择 Worker/ }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('w1')); // 回退首名（推导默认）
    // 失效值不被当有效选择持久化——空选择=清除记忆键（回退=推导而非写入）
    expect(window.localStorage.getItem('agentteams:kb:worker')).toBeNull();
  });
});
