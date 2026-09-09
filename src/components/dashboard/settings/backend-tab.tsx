'use client';

// Settings > 后端 tab (F1b): the server-side backend address config that
// the first-launch setup page writes (F1a), editable after login.
//
// Visible to ALL logged-in users; save permissions follow the server:
//   - L1 (level 3, admin): save directly, no token.
//   - L2 (level < 3): save requires the first-launch setup token — the
//     standalone instance owner (who typically logs in via the Matrix
//     track) keeps editing rights via that owner credential, while a peer
//     L2 in a multi-user deployment cannot shadow the env config.
//     The token is shown once at first launch (docker logs) and persists
//     in the .setup-token file next to the config. It is never stored
//     client-side — cleared from the input after each save.
//
// - Reads GET /api/agentteams/setup/backends — the `config` field
//   (structured internal/external per backend) is returned to any
//   authenticated session.
// - Per-field "测试" button → POST /api/agentteams/setup/backends/test
//   (server-side probe; a pass also seeds the failover working cache).
// - 保存 → POST /api/agentteams/setup/backends (L1 path, or owner path
//   with token). Empty fields are omitted; the server rejects a payload
//   with no address at all ("at least one address is required").
//
// Resolution priority (documented for the user): config file > env vars >
// embedded defaults; the last-known-working candidate (probe TTL) wins.
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Loader2,
  Save,
  Server,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { apiUrl } from '@/lib/api-base';
import { BACKEND_LABELS, BACKEND_NAMES, REQUIRED_BACKENDS } from '@/lib/backend-names';
import { useAgentTeamsStore } from '@/lib/agentteams-store';

interface BackendAddrs {
  internal?: string;
  external?: string;
}

interface BackendsState {
  configured: boolean;
  backends: Record<string, { configured: boolean; candidates: string[] }>;
  config?: Record<string, BackendAddrs>;
}

interface TestOutcome {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  error?: string;
}

type TestKey = string; // `${backend}:${slot}`

function initialFields(config: Record<string, BackendAddrs> | undefined) {
  const out: Record<string, { internal: string; external: string }> = {};
  for (const name of BACKEND_NAMES) {
    out[name] = {
      internal: config?.[name]?.internal ?? '',
      external: config?.[name]?.external ?? '',
    };
  }
  return out;
}

export function BackendTab() {
  const queryClient = useQueryClient();
  const { userLevel } = useAgentTeamsStore();
  const isL1 = userLevel >= 3;
  const [state, setState] = useState<BackendsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [fields, setFields] = useState<Record<string, { internal: string; external: string }>>({});
  const [tests, setTests] = useState<Record<TestKey, TestOutcome | 'running'>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // L2-only: first-launch setup token (owner credential). Never persisted
  // client-side; cleared after each save.
  const [setupToken, setSetupToken] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/agentteams/setup/backends/'), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BackendsState;
      setState(data);
      setFields(initialFields(data.config));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setField = (backend: string, slot: 'internal' | 'external', value: string) => {
    setFields((prev) => ({ ...prev, [backend]: { ...prev[backend], [slot]: value } }));
    setSaved(false);
    setSaveError(null);
  };

  const handleTest = async (backend: string, slot: 'internal' | 'external') => {
    const url = (fields[backend]?.[slot] ?? '').trim();
    const key: TestKey = `${backend}:${slot}`;
    if (!url) {
      setTests((prev) => ({ ...prev, [key]: { ok: false, error: '请先填写地址' } }));
      return;
    }
    setTests((prev) => ({ ...prev, [key]: 'running' }));
    try {
      const res = await fetch(apiUrl('/api/agentteams/setup/backends/test/'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backend, url }),
      });
      const data = (await res.json()) as TestOutcome & { error?: string };
      setTests((prev) => ({ ...prev, [key]: { ok: res.ok && data.ok, latencyMs: data.latencyMs, status: data.status, error: res.ok ? data.error : `HTTP ${res.status}` } }));
    } catch {
      setTests((prev) => ({ ...prev, [key]: { ok: false, error: '测试请求失败' } }));
    }
  };

  const handleSave = async () => {
    const tokenValue = isL1 ? '' : setupToken.trim();
    if (!isL1 && !tokenValue) {
      setSaveError('非管理员保存需填写首次配置 token（首启时 docker logs 打印，或 .setup-token 文件）');
      return;
    }
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const backends: Record<string, BackendAddrs> = {};
      for (const name of BACKEND_NAMES) {
        const internal = (fields[name]?.internal ?? '').trim();
        const external = (fields[name]?.external ?? '').trim();
        if (internal || external) {
          backends[name] = { ...(internal ? { internal } : {}), ...(external ? { external } : {}) };
        }
      }
      const res = await fetch(apiUrl('/api/agentteams/setup/backends/'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isL1 ? { backends } : { backends, token: tokenValue }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setSaved(true);
        if (!isL1) setSetupToken(''); // never keep the token in the input
        await load();
        // The overview infrastructure panel re-resolves per request; just
        // nudge it so the health tiles reflect the new addresses promptly.
        void queryClient.invalidateQueries({ queryKey: ['agentteams-infrastructure'] });
      } else {
        setSaveError(data.error === 'invalid-token' ? 'token 不正确' : data.error ?? `HTTP ${res.status}`);
      }
    } catch {
      setSaveError('保存请求失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !state) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        加载后端配置…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground leading-relaxed">
        地址保存在服务端配置文件（<code className="font-mono">DASHBOARD_CONFIG_FILE</code>，数据卷上），保存后立即生效。
        解析优先级：本配置 &gt; 环境变量 &gt; 内置默认；某地址探活失败后 60 秒内自动切到另一可用候选（内网/外网 failover）。
        {!isL1 && (
          <span className="block mt-1">
            当前身份非管理员：查看/测试可用，<b>保存需首次配置 token</b>（首启时 <code className="font-mono">docker logs</code> 打印一次，或配置同目录 <code className="font-mono">.setup-token</code> 文件）。
          </span>
        )}
      </p>

      {BACKEND_NAMES.map((name) => {
        const candidates = state.backends[name]?.candidates ?? [];
        const required = REQUIRED_BACKENDS.includes(name);
        const missingRequired = required && candidates.length === 0;
        return (
          <div key={name} className="space-y-1.5 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Server className="w-3.5 h-3.5 text-muted-foreground" />
              <Label className="text-sm">{BACKEND_LABELS[name]}</Label>
              {missingRequired && (
                <Badge variant="destructive" className="text-[10px] h-4 px-1.5">
                  无可用地址（影响登录/数据面）
                </Badge>
              )}
            </div>
            {(['internal', 'external'] as const).map((slot) => {
              const key: TestKey = `${name}:${slot}`;
              const test = tests[key];
              return (
                <div key={slot} className="flex items-center gap-2 pl-5">
                  <span className="w-14 text-xs text-muted-foreground shrink-0">
                    {slot === 'internal' ? '内网' : '外网'}
                  </span>
                  <Input
                    value={fields[name]?.[slot] ?? ''}
                    onChange={(e) => setField(name, slot, e.target.value)}
                    placeholder="http://host:port（可选，留空=用 env/内置）"
                    className="h-8 text-xs flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => handleTest(name, slot)}
                    disabled={test === 'running'}
                  >
                    {test === 'running' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      '测试'
                    )}
                  </Button>
                  {test && test !== 'running' && (
                    <span className="shrink-0">
                      {test.ok ? (
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5 gap-1 border-emerald-500/50 text-emerald-600">
                          <CheckCircle2 className="w-3 h-3" />
                          {test.latencyMs !== undefined ? `${test.latencyMs}ms` : 'OK'}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5 gap-1 border-red-500/50 text-red-600 max-w-44" title={test.error}>
                          <XCircle className="w-3 h-3 shrink-0" />
                          <span className="truncate">{test.error ?? '失败'}</span>
                        </Badge>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
            {candidates.length > 0 && (
              <p className="pl-5 text-[10px] text-muted-foreground truncate">
                当前候选顺序：{candidates.join(' → ')}
              </p>
            )}
          </div>
        );
      })}

      {!isL1 && (
        <div className="space-y-1">
          <Label htmlFor="setup-token" className="text-xs">首次配置 token（保存用）</Label>
          <Input
            id="setup-token"
            type="password"
            value={setupToken}
            onChange={(e) => { setSetupToken(e.target.value); setSaved(false); setSaveError(null); }}
            placeholder="首启 setup 页用的那个 token"
            className="h-8 text-xs max-w-sm"
            autoComplete="off"
          />
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-1" />
          )}
          保存配置
        </Button>
        {saved && (
          <span className="text-xs text-emerald-600 flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" /> 已保存，立即生效
          </span>
        )}
        {saveError && <span className="text-xs text-destructive">{saveError}</span>}
      </div>
    </div>
  );
}
