import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@/hooks/use-agentteams-workers', () => ({
  useWorkers: vi.fn(() => ({
    data: [{ name: 'w1', runtime: 'qwenpaw' }],
    isLoading: false,
    error: null,
  })),
}));

// MarkdownMessage 替身（避免拉聊天栈；断言透传 content）
vi.mock('@/components/dashboard/sections/chat/markdown-message', () => ({
  MarkdownMessage: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

import { KnowledgeSection } from './knowledge-section';
import { useWorkers } from '@/hooks/use-agentteams-workers';

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

function mockFetch(statuses?: { memory?: number; digest?: number; content?: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = url as string;
      let status = 200;
      let body: unknown = {};
      if (u.includes('/tree')) {
        if (u.includes('path=memory')) { status = statuses?.memory ?? 200; body = TREE_MEMORY; }
        else { status = statuses?.digest ?? 200; body = TREE_DIGEST; }
      } else if (u.includes('/file-content')) {
        const m = u.match(/path=([^&]+)/);
        const p = m ? decodeURIComponent(m[1]) : '';
        status = statuses?.content ?? 200;
        body = { content: CONTENTS[p] ?? '', eof: true, offset: 0, next_offset: 0, etag: 'x' };
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

describe('B7 KnowledgeSection（#1208 消费）', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('① #1208 未合并（404）→ 占位横幅', async () => {
    mockFetch({ memory: 404, digest: 404 });
    render(<KnowledgeSection />);
    expect(await screen.findByText(/当前 Controller 版本未提供/)).toBeInTheDocument();
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

  it('④ 文件视图：展开 memory 目录 → 点文件预览', async () => {
    mockFetch();
    render(<KnowledgeSection />);
    await screen.findByText('知识库');
    fireEvent.click(screen.getByRole('button', { name: /文件/ }));
    fireEvent.click(screen.getByText('memory'));
    const fileBtn = await screen.findByText('a.md');
    fireEvent.click(fileBtn);
    expect(await screen.findByText('memory/a.md')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('md').textContent).toBe('see [[b]] and [[MEMORY]]'));
  });

  it('⑤ 502 → 错误横幅透出 controller 详情（worker workspace API unreachable）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        headers: new Headers(),
        json: async () => ({ message: 'worker workspace API unreachable' }),
      }) as unknown as Response),
    );
    render(<KnowledgeSection />);
    expect(
      await screen.findByText(/tree memory → worker workspace API unreachable/),
    ).toBeInTheDocument();
  });

  it('⑤b 200 + HTML 响应体 → 可读报错而非 SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<!doctype html><html><body>gateway page</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    );
    render(<KnowledgeSection />);
    expect(
      await screen.findByText(/tree memory → 服务返回了非预期的页面而非 JSON/),
    ).toBeInTheDocument();
  });

  it('⑤c 401 → 提示重新登录', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    render(<KnowledgeSection />);
    expect(await screen.findByText(/登录已过期，请刷新页面重新登录/)).toBeInTheDocument();
  });

  it('⑥ worker 下拉仅列 qwenpaw 运行时（FUNC-10 过滤）', async () => {
    vi.mocked(useWorkers).mockReturnValue({
      data: [
        { name: 'oc-w', runtime: 'openclaw' },
        { name: 'qw-w', runtime: 'qwenpaw' },
      ],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkers>);
    mockFetch();
    render(<KnowledgeSection />);
    const select = await screen.findByRole('combobox', { name: '选择 Worker' });
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['qw-w']);
    // 运行时徽章提示数据面来源
    expect(screen.getByText('QwenPaw')).toBeInTheDocument();
    // 首个合法 worker 自动加载（请求路径指向 qw-w，oc-w 被过滤）
    await waitFor(() => {
      const called = vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('workers/qw-w/workspace-files'));
      expect(called).toBe(true);
    });
    const ocCalled = vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('workers/oc-w/'));
    expect(ocCalled).toBe(false);
  });

  it('⑦ 全部非 qwenpaw → 仅支持 QwenPaw 空态说明且不发请求', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(useWorkers).mockReturnValue({
      data: [{ name: 'oc-w', runtime: 'openclaw' }],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkers>);
    render(<KnowledgeSection />);
    expect(
      await screen.findByText(/知识库当前仅支持 QwenPaw 运行时的 Worker/),
    ).toBeInTheDocument();
    // KB 数据面为 QwenPaw 专属：空态下不得向 workspace-files 发请求
    await waitFor(() => {
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
