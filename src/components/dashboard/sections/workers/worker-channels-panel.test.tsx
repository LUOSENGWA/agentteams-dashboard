import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WorkerChannelsPanel } from './worker-channels-panel';

const SCHEMAS = {
  qq: {
    label: 'QQ',
    description: '',
    plugin_id: 'qq',
    config_fields: [
      { name: 'enabled', label: '启用', type: 'switch' },
      { name: 'app_id', label: 'App ID', type: 'text', required: true },
      { name: 'client_secret', label: 'Client Secret', type: 'password' },
    ],
  },
  matrix: { label: 'Matrix', description: '', plugin_id: 'matrix', config_fields: [{ name: 'enabled', label: '启用', type: 'switch' }] },
};

const CHANNELS = {
  qq: { enabled: true, app_id: '123', client_secret: 's3cret' },
  matrix: { enabled: false },
};

interface RouteMock {
  method: string;
  re: RegExp;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
let routes: RouteMock[] = [];
let calls: Array<{ url: string; method: string; body?: string }> = [];

function mockRoutes(list: RouteMock[]) {
  routes = list;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, body });
      const hit = routes.find((r) => r.re.test(url) && r.method === method);
      const status = hit?.status ?? (hit ? 200 : 404);
      const payload = hit?.body ?? { detail: 'not found' };
      return {
        ok: status < 400,
        status,
        headers: new Headers(hit?.headers ?? {}),
        json: async () => payload,
      } as unknown as Response;
    }),
  );
}

const ALL_GOOD: RouteMock[] = [
  { method: 'GET', re: /\/channels$/, body: CHANNELS },
  { method: 'GET', re: /\/channels\/types$/, body: ['qq', 'matrix'] },
  { method: 'GET', re: /\/channels\/schemas$/, body: SCHEMAS },
  { method: 'GET', re: /\/channels\/qq\/health$/, body: { channel: 'qq', status: 'healthy', detail: '' } },
];

describe('B4 WorkerChannelsPanel（#1219 九端点消费）', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('① 404（#1219 未合并）→ 占位横幅', async () => {
    mockRoutes([]);
    render(<WorkerChannelsPanel workerName="w1" />);
    expect(await screen.findByText(/待上游 #1219 合并/)).toBeInTheDocument();
  });

  it('② 200 → 列表渲染（类型顺序 + schema 标签 + health 点）', async () => {
    mockRoutes(ALL_GOOD);
    render(<WorkerChannelsPanel workerName="w1" />);
    expect(await screen.findByText('频道接入（#1219）')).toBeInTheDocument();
    expect(screen.getByText('QQ')).toBeInTheDocument();
    expect(screen.getByText('Matrix')).toBeInTheDocument();
    expect(screen.getByText('未启用')).toBeInTheDocument(); // matrix.enabled=false
    await waitFor(() => expect(screen.queryByTitle('健康检查中…')).not.toBeInTheDocument());
  });

  it('③ 编辑保存 → PUT body=完整配置（含未改字段）+ 读回验证 + MinIO 头展示', async () => {
    mockRoutes([
      ...ALL_GOOD,
      { method: 'PUT', re: /\/channels\/qq$/, body: { enabled: true, app_id: '999', client_secret: 's3cret' }, headers: { 'x-agentteams-minio-persisted': 'true' } },
      { method: 'GET', re: /\/channels\/qq$/, body: { enabled: true, app_id: '999', client_secret: 's3cret' } },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await screen.findByText('频道接入（#1219）');
    fireEvent.click(screen.getByText('QQ'));
    fireEvent.change(screen.getByDisplayValue('123'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!)).toEqual({ enabled: true, app_id: '999', client_secret: 's3cret' });
    });
    expect(await screen.findByText(/读回验证通过/)).toBeInTheDocument();
    expect(screen.getByText(/MinIO 基线已收敛/)).toBeInTheDocument();
  });

  it('④ 读回不一致 → 提示手动核对', async () => {
    mockRoutes([
      ...ALL_GOOD,
      { method: 'PUT', re: /\/channels\/qq$/, body: {}, headers: { 'x-agentteams-minio-persisted': 'false' } },
      { method: 'GET', re: /\/channels\/qq$/, body: { enabled: true, app_id: 'DIFF', client_secret: 's3cret' } },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await screen.findByText('频道接入（#1219）');
    fireEvent.click(screen.getByText('QQ'));
    fireEvent.change(screen.getByDisplayValue('123'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    expect(await screen.findByText(/读回不一致（app_id）/)).toBeInTheDocument();
  });

  it('⑤ restart → POST /qq/restart + 成功提示', async () => {
    mockRoutes([
      ...ALL_GOOD,
      { method: 'POST', re: /\/channels\/qq\/restart$/, body: { channel: 'qq', status: 'restarted', detail: '' } },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await screen.findByText('频道接入（#1219）');
    // types=['qq','matrix'] 两行都有「重启」——取第一行（qq 在 types 序首）
    fireEvent.click(screen.getAllByRole('button', { name: /重启/ })[0]);
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post).toBeTruthy();
      expect(post!.url).toMatch(/\/channels\/qq\/restart$/);
    });
    expect(await screen.findByText(/已重启频道/)).toBeInTheDocument();
  });

  it('⑥ 二维码流：img base64 渲染 + 轮询 success → 凭证回写 PUT', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusCall = 0;
    const qrRoutes: RouteMock[] = [
      ...ALL_GOOD,
      { method: 'GET', re: /\/channels\/qq\/qrcode$/, body: { qrcode_img: 'BASE64PNG', poll_token: 'tok1' } },
      { method: 'GET', re: /\/channels\/qq\/qrcode\/status$/, body: {} },
      { method: 'PUT', re: /\/channels\/qq$/, body: {} },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = typeof init?.body === 'string' ? init.body : undefined;
        calls.push({ url, method, body });
        const hit = qrRoutes.find((r) => r.re.test(url) && r.method === method);
        if (url.includes('/qrcode/status')) {
          statusCall += 1;
          const payload = statusCall < 2
            ? { status: 'waiting', credentials: {} }
            : { status: 'success', credentials: { app_id: 'newid' } };
          return { ok: true, status: 200, headers: new Headers(), json: async () => payload } as unknown as Response;
        }
        const status = hit?.status ?? (hit ? 200 : 404);
        return {
          ok: status < 400,
          status,
          headers: new Headers(hit?.headers ?? {}),
          json: async () => hit?.body ?? { detail: 'not found' },
        } as unknown as Response;
      }),
    );
    render(<WorkerChannelsPanel workerName="w1" />);
    await vi.advanceTimersByTimeAsync(10); // 触发初始 load
    await screen.findByText('频道接入（#1219）');
    fireEvent.click(screen.getAllByRole('button', { name: /扫码/ })[0]);
    // 假定时器 + React MessageChannel 调度竞态 → 用 findBy 轮询兜底
    const img = (await screen.findByAltText('扫码登录 qq', {}, { timeout: 3000 })) as HTMLImageElement;
    expect(img.src).toContain('data:image/png;base64,BASE64PNG');
    await vi.advanceTimersByTimeAsync(2000); // poll 1 → waiting
    await vi.advanceTimersByTimeAsync(2000); // poll 2 → success
    await screen.findByText('扫码成功，可回写凭证。', {}, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /回写凭证/ }));
    await waitFor(() => {
      const puts = calls.filter((c) => c.method === 'PUT');
      expect(puts.length).toBeGreaterThan(0);
      expect(JSON.parse(puts[puts.length - 1].body!)).toEqual({
        enabled: true,
        app_id: 'newid',
        client_secret: 's3cret',
      });
    });
  });
});
