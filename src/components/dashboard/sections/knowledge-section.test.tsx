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
      } as unknown as Response;
    }),
  );
}

describe('KnowledgeSection（v2：docker-proxy 数据面 + 四分类 + 团队分组）', () => {
  beforeEach(() => {
    vi.useRealTimers();
    workersHolder.list = [
      { name: 'w1', team: 't1', role: 'team_leader' },
      { name: 'w2', team: 't2', role: 'worker' },
    ];
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

  it('② 200 → wikilink 图谱：节点+边+标签', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    const svg = (await screen.findByRole('img', { name: /wikilink 图谱/ })) as unknown as { querySelectorAll: (_s: string) => NodeListOf<SVGElement> };
    const texts = Array.from(svg.querySelectorAll('text')).map((t) => t.textContent ?? '');
    expect(texts).toContain('MEMORY'); // MEMORY.md 干
    expect(texts).toContain('a');
    expect(texts).toContain('b');
    // a.md 链接 [[b]] 与 [[MEMORY]] → 2 条边
    expect(svg.querySelectorAll('line').length).toBe(2);
  });

  it('③ 点图谱节点 → 打开 md 预览（MarkdownMessage 透传）', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    const svg = (await screen.findByRole('img', { name: /wikilink 图谱/ })) as unknown as { querySelectorAll: (_s: string) => NodeListOf<SVGElement> };
    const nodeA = Array.from(svg.querySelectorAll('text')).find((t) => t.textContent === 'a')!;
    fireEvent.click(nodeA);
    expect(await screen.findByText('memory/a.md')).toBeInTheDocument();
    const md = await screen.findByTestId('md');
    expect(md.textContent).toBe('see [[b]] and [[MEMORY]]');
  });

  it('④ 文件视图：四分类分组 + 展开 memory → 点文件预览', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    await screen.findByText('知识库');
    // 视图切换按钮（分组标签 <p>文件 同名，按 role 限 button）
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    // 四分类分组头（'文件' 与视图切换按钮同名，按 <p> 限定）
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
  });

  it('⑥ 默认 worker 钉住：轮询重取顺序漂移不重置视图（展开的目录保留）', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    const select = screen.getByRole('combobox', { name: /选择 Worker/ }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('w1')); // 首份列表钉住 w1
    // 展开 memory/
    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    fireEvent.click(screen.getByText('memory/'));
    await screen.findByText('a.md');
    // 轮询重取：列表顺序漂移（w2 变第一）+ 触发重渲染
    workersHolder.list = [
      { name: 'w2', team: 't2', role: 'worker' },
      { name: 'w1', team: 't1', role: 'team_leader' },
    ];
    fireEvent.click(screen.getByRole('button', { name: '图谱' }));
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
});
