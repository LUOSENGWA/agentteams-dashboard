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

// builtin 频道（/schemas 无 config_fields → 走模板表）
const DINGTALK_CHANNEL = {
  dingtalk: { enabled: false, client_id: 'cid1', client_secret: 'cs', isBuiltin: true },
};
const DINGTALK_ROUTES: RouteMock[] = [
  { method: 'GET', re: /\/channels$/, body: DINGTALK_CHANNEL },
  { method: 'GET', re: /\/channels\/types$/, body: ['dingtalk'] },
  { method: 'GET', re: /\/channels\/schemas$/, body: {} },
];
const openDingtalkEdit = async () => {
  await screen.findByText('频道接入（#1219）');
  fireEvent.click(screen.getByRole('button', { name: /dingtalk/ }));
};

describe('B4 WorkerChannelsPanel（#1219/#1269 十端点消费，合并版契约）', () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('① 404（版本门）→ 占位横幅（双源措辞）', async () => {
    mockRoutes([]);
    render(<WorkerChannelsPanel workerName="w1" />);
    expect(await screen.findByText(/当前 Controller 未提供频道端点/)).toBeInTheDocument();
    expect(screen.getByText(/QwenPaw 版本过旧/)).toBeInTheDocument();
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

  it('⑦ builtin 模板表单（/schemas 无该频道）：类型化字段 + secret 密码框 + policy 下拉', async () => {
    mockRoutes(DINGTALK_ROUTES);
    render(<WorkerChannelsPanel workerName="w1" />);
    await openDingtalkEdit();
    // 模板字段：identity 值回填
    expect(screen.getByDisplayValue('cid1')).toBeInTheDocument();
    const pwd = document.querySelector('input[type="password"]');
    expect(pwd).not.toBeNull();
    expect((pwd as HTMLInputElement).value).toBe('cs');
    // access 块：dm_policy select（options open/allowlist）
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(2);
    // 基础块字段在位（enabled 在前，display 块在后）
    expect(screen.getByLabelText('enabled')).toBeInTheDocument();
    expect(screen.getByLabelText('show_thinking')).toBeInTheDocument();
  });

  it('⑧ 保存 → PUT body 剥离 isBuiltin（disabled 频道跳过预检直接 PUT）', async () => {
    mockRoutes([
      ...DINGTALK_ROUTES,
      { method: 'PUT', re: /\/channels\/dingtalk$/, body: { enabled: false, client_id: 'cid1', client_secret: 'cs' } },
      { method: 'GET', re: /\/channels\/dingtalk$/, body: { enabled: false, client_id: 'cid1', client_secret: 'cs' } },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await openDingtalkEdit();
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse(put!.body!);
      expect(body).toEqual({ enabled: false, client_id: 'cid1', client_secret: 'cs' });
      expect(body).not.toHaveProperty('isBuiltin');
    });
    expect(await screen.findByText(/已保存/)).toBeInTheDocument();
    // enabled=false → 不发 conflict-check
    expect(calls.some((c) => c.url.includes('/conflict-check'))).toBe(false);
  });

  it('⑨ conflict-check 命中 → 冲突确认 UI 阻断保存，「仍要保存」才发 PUT', async () => {
    mockRoutes([
      { method: 'GET', re: /\/channels$/, body: { dingtalk: { enabled: true, client_id: 'cid1' } } },
      { method: 'GET', re: /\/channels\/types$/, body: ['dingtalk'] },
      { method: 'GET', re: /\/channels\/schemas$/, body: {} },
      { method: 'GET', re: /\/channels\/dingtalk\/health$/, body: { channel: 'dingtalk', status: 'healthy', detail: '' } },
      { method: 'POST', re: /\/channels\/dingtalk\/conflict-check$/, body: { conflict: true, agents: [{ agent_id: 'a1', agent_name: 'Alpha' }] } },
      { method: 'PUT', re: /\/channels\/dingtalk$/, body: { enabled: true, client_id: 'cid1' } },
      { method: 'GET', re: /\/channels\/dingtalk$/, body: { enabled: true, client_id: 'cid1' } },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await openDingtalkEdit();
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    expect(await screen.findByText(/Bot 冲突/)).toBeInTheDocument();
    expect(screen.getByText(/Alpha \(a1\)/)).toBeInTheDocument();
    // 冲突未确认前 PUT 未发
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /仍要保存/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(await screen.findByText(/已保存/)).toBeInTheDocument();
  });

  it('⑩ conflict-check 无冲突 → 直接保存', async () => {
    mockRoutes([
      { method: 'GET', re: /\/channels$/, body: { dingtalk: { enabled: true, client_id: 'cid1' } } },
      { method: 'GET', re: /\/channels\/types$/, body: ['dingtalk'] },
      { method: 'GET', re: /\/channels\/schemas$/, body: {} },
      { method: 'POST', re: /\/channels\/dingtalk\/conflict-check$/, body: { conflict: false, agents: [] } },
      { method: 'PUT', re: /\/channels\/dingtalk$/, body: { enabled: true, client_id: 'cid1' } },
      { method: 'GET', re: /\/channels\/dingtalk$/, body: { enabled: true, client_id: 'cid1' } },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await openDingtalkEdit();
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(await screen.findByText(/已保存/)).toBeInTheDocument();
    expect(screen.queryByText(/Bot 冲突/)).not.toBeInTheDocument();
  });

  it('⑪ conflict-check 404（2.0.x 版本门）→ warn 继续保存不阻塞', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRoutes([
      { method: 'GET', re: /\/channels$/, body: { dingtalk: { enabled: true, client_id: 'cid1' } } },
      { method: 'GET', re: /\/channels\/types$/, body: ['dingtalk'] },
      { method: 'GET', re: /\/channels\/schemas$/, body: {} },
      { method: 'PUT', re: /\/channels\/dingtalk$/, body: { enabled: true, client_id: 'cid1' } },
      { method: 'GET', re: /\/channels\/dingtalk$/, body: { enabled: true, client_id: 'cid1' } },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await openDingtalkEdit();
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(await screen.findByText(/已保存/)).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('⑫ console 频道保存强制 enabled=true（mirror keepConsoleEnabled）', async () => {
    mockRoutes([
      { method: 'GET', re: /\/channels$/, body: { console: { enabled: false, isBuiltin: true } } },
      { method: 'GET', re: /\/channels\/types$/, body: ['console'] },
      { method: 'GET', re: /\/channels\/schemas$/, body: {} },
      { method: 'POST', re: /\/channels\/console\/conflict-check$/, body: { conflict: false, agents: [] } },
      { method: 'PUT', re: /\/channels\/console$/, body: { enabled: true } },
      { method: 'GET', re: /\/channels\/console$/, body: { enabled: true } },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await screen.findByText('频道接入（#1219）');
    fireEvent.click(screen.getByRole('button', { name: /console/ }));
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!)).toEqual({ enabled: true });
    });
    // 预检以强制后的 enabled=true 发出
    const preflight = calls.find((c) => c.url.includes('/conflict-check'));
    expect(preflight).toBeTruthy();
    expect(JSON.parse(preflight!.body!)).toEqual({ enabled: true });
  });

  it('⑬ allow_from list 字段：逗号分隔渲染 + 保存回 list', async () => {
    mockRoutes([
      { method: 'GET', re: /\/channels$/, body: { dingtalk: { enabled: false, allow_from: ['a', 'b'] } } },
      { method: 'GET', re: /\/channels\/types$/, body: ['dingtalk'] },
      { method: 'GET', re: /\/channels\/schemas$/, body: {} },
      { method: 'PUT', re: /\/channels\/dingtalk$/, body: { enabled: false, allow_from: ['c', 'd'] } },
      { method: 'GET', re: /\/channels\/dingtalk$/, body: { enabled: false, allow_from: ['c', 'd'] } },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await openDingtalkEdit();
    const listInput = screen.getByDisplayValue('a, b') as HTMLInputElement;
    fireEvent.change(listInput, { target: { value: 'c, d' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!)).toEqual({ enabled: false, allow_from: ['c', 'd'] });
    });
  });

  it('⑭ 未知字段类型推断（future key：bool→switch / array→list / secret 名→password）', async () => {
    mockRoutes([
      {
        method: 'GET',
        re: /\/channels$/,
        body: { dingtalk: { enabled: false, future_flag: true, future_list: ['x'], future_secret_token: 'zzz' } },
      },
      { method: 'GET', re: /\/channels\/types$/, body: ['dingtalk'] },
      { method: 'GET', re: /\/channels\/schemas$/, body: {} },
    ]);
    render(<WorkerChannelsPanel workerName="w1" />);
    await openDingtalkEdit();
    expect(screen.getByLabelText('future_flag')).not.toBeNull();
    expect((screen.getByLabelText('future_flag') as HTMLInputElement).type).toBe('checkbox');
    expect(screen.getByDisplayValue('x')).toBeInTheDocument();
    const pwds = Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    expect(pwds.some((i) => i.value === 'zzz')).toBe(true);
  });

  it('⑮ 扫码按钮门控（仅 QRCODE_AUTH_HANDLERS 五频道：qq 有 / matrix 无）', async () => {
    mockRoutes(ALL_GOOD);
    render(<WorkerChannelsPanel workerName="w1" />);
    await screen.findByText('频道接入（#1219）');
    // types=['qq','matrix']：只有 qq（∈ 五频道）行渲染「扫码」，「重启」两行都有
    expect(screen.getAllByRole('button', { name: /扫码/ }).length).toBe(1);
    expect(screen.getAllByRole('button', { name: /重启/ }).length).toBe(2);
  });
});
