'use client';

// First-launch backend setup (F1). Rendered INSTEAD OF the login form when
// the dashboard has no usable backend addresses yet (standalone docker
// install without env configuration).
//
// Pre-login writes are one-shot and token-gated: the token comes from the
// server log ("one-time backend setup token") or the DASHBOARD_SETUP_TOKEN
// env var. After the config is saved the login page appears and this screen
// can never be reached again from a logged-out browser (level-3 session
// updates go through the settings dialog, F1b).
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiUrl } from '@/lib/api-base';
import {
  BACKEND_LABELS,
  BACKEND_NAMES,
  EMBEDDED_DEFAULTS,
  REQUIRED_BACKENDS,
  type BackendName,
} from '@/lib/backend-names';

interface BackendStatus {
  configured: boolean;
  candidates: string[];
}

interface SetupStatusResponse {
  configured: boolean;
  backends: Record<BackendName, BackendStatus>;
  embedded: {
    defaults: Record<BackendName, string | undefined>;
    healthy: Record<BackendName, boolean> | null;
  };
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; detail: string }
  | { status: 'fail'; detail: string };

const EMPTY_TEST: TestState = { status: 'idle' };

export function BackendSetupPage({ onDone }: { onDone: () => void }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addrs, setAddrs] = useState<Record<BackendName, { internal: string; external: string }>>(
    () =>
      Object.fromEntries(
        BACKEND_NAMES.map((name) => [name, { internal: '', external: '' }]),
      ) as Record<BackendName, { internal: string; external: string }>,
  );
  const [embeddedHealthy, setEmbeddedHealthy] = useState(false);
  const [token, setToken] = useState('');
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/agentteams/setup/backends'), { credentials: 'same-origin' })
      .then((res) => res.json().catch(() => null))
      .then((data: SetupStatusResponse | null) => {
        if (cancelled || !data) {
          if (!cancelled) {
            setLoading(false);
            setLoadError('读取后端配置状态失败，请刷新重试');
          }
          return;
        }
        const next = Object.fromEntries(
          BACKEND_NAMES.map((name) => {
            const candidates = data.backends?.[name]?.candidates ?? [];
            return [name, { internal: candidates[0] ?? '', external: candidates[1] ?? '' }];
          }),
        ) as Record<BackendName, { internal: string; external: string }>;
        setAddrs(next);
        setEmbeddedHealthy(
          !!data.embedded?.healthy &&
            REQUIRED_BACKENDS.every((name) => data.embedded.healthy?.[name] === true),
        );
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setLoadError('读取后端配置状态失败，请刷新重试');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setSlot = (name: BackendName, slot: 'internal' | 'external', value: string) => {
    setAddrs((prev) => ({ ...prev, [name]: { ...prev[name], [slot]: value } }));
    setTests((prev) => ({ ...prev, [`${name}:${slot}`]: EMPTY_TEST }));
  };

  const runTest = useCallback(async (name: BackendName, slot: 'internal' | 'external') => {
    const url = addrs[name][slot].trim();
    if (!url) return;
    const key = `${name}:${slot}`;
    setTests((prev) => ({ ...prev, [key]: { status: 'testing' } }));
    try {
      const res = await fetch(apiUrl('/api/agentteams/setup/backends/test'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backend: name, url }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: number;
        latencyMs?: number;
        error?: string;
      };
      setTests((prev) => ({
        ...prev,
        [key]: data.ok
          ? { status: 'ok', detail: `HTTP ${data.status} · ${data.latencyMs}ms` }
          : { status: 'fail', detail: data.error || `HTTP ${data.status}` },
      }));
    } catch (err) {
      setTests((prev) => ({
        ...prev,
        [key]: { status: 'fail', detail: err instanceof Error ? err.message : '测试请求失败' },
      }));
    }
  }, [addrs]);

  const applyEmbeddedDefaults = () => {
    setAddrs(
      Object.fromEntries(
        BACKEND_NAMES.map((name) => [
          name,
          { internal: EMBEDDED_DEFAULTS[name] ?? '', external: '' },
        ]),
      ) as Record<BackendName, { internal: string; external: string }>,
    );
    setTests({});
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    const backends: Record<string, { internal?: string; external?: string }> = {};
    for (const name of BACKEND_NAMES) {
      const internal = addrs[name].internal.trim();
      const external = addrs[name].external.trim();
      if (internal || external) backends[name] = { internal: internal || undefined, external: external || undefined };
    }
    try {
      const res = await fetch(apiUrl('/api/agentteams/setup/backends'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.trim(), backends }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        onDone();
        return;
      }
      const messages: Record<string, string> = {
        'token-required': '缺少首次启动 token',
        'invalid-token': '首次启动 token 不正确（见服务器日志 docker logs <容器>，或 env DASHBOARD_SETUP_TOKEN）',
        'already-configured': '后端已配置过；请刷新页面（或让管理员在设置里修改）',
      };
      setSaveError(messages[data.error ?? ''] || data.error || `保存失败（HTTP ${res.status}）`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>后端配置</CardTitle>
            <CardDescription>{loadError}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => window.location.reload()}>
              <RefreshCw className="mr-2 size-4" />
              刷新
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-muted/30 p-4 md:p-8">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-lg">后端配置（首次启动）</CardTitle>
          <CardDescription>
            Dashboard 还没有可用的后端地址。填写后保存即可登录；配置保存在挂载卷中，重启不丢失。
            每个后端可只填一个地址；「内网」= 容器/集群网络，「外网」= 跨网段备用（自动切换）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {embeddedHealthy && (
            <div className="flex items-center justify-between rounded-md border bg-muted/50 px-3 py-2">
              <span className="text-sm">检测到嵌入式部署（内置地址可用）</span>
              <Button size="sm" variant="outline" onClick={applyEmbeddedDefaults}>
                使用内置默认地址
              </Button>
            </div>
          )}

          <div className="space-y-4">
            {BACKEND_NAMES.map((name) => (
              <div key={name} className="rounded-md border p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  {BACKEND_LABELS[name]}
                  {REQUIRED_BACKENDS.includes(name) && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      必需
                    </span>
                  )}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {(['internal', 'external'] as const).map((slot) => {
                    const key = `${name}:${slot}`;
                    const test = tests[key] ?? EMPTY_TEST;
                    return (
                      <div key={slot} className="space-y-1">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{slot === 'internal' ? '内网地址' : '外网地址（备用）'}</span>
                          <span className="inline-flex items-center gap-1">
                            {test.status === 'ok' && (
                              <>
                                <CheckCircle2 className="size-3.5 text-green-600" />
                                {test.detail}
                              </>
                            )}
                            {test.status === 'fail' && (
                              <>
                                <XCircle className="size-3.5 text-red-600" />
                                {test.detail}
                              </>
                            )}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <Input
                            value={addrs[name][slot]}
                            onChange={(e) => setSlot(name, slot, e.target.value)}
                            placeholder="http://host:port"
                            spellCheck={false}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!addrs[name][slot].trim() || test.status === 'testing'}
                            onClick={() => runTest(name, slot)}
                          >
                            {test.status === 'testing' ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              '测试'
                            )}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <div className="text-sm font-medium">首次启动 token</div>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="见服务器日志或 DASHBOARD_SETUP_TOKEN"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              仅首次保存需要。token 在服务器日志里（docker logs &lt;容器&gt;，搜
              setup token），也可用 env DASHBOARD_SETUP_TOKEN 预先指定；保存成功后不再需要。
            </p>
          </div>

          {saveError && <p className="text-sm text-red-600">{saveError}</p>}

          <div className="flex justify-end gap-2">
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              保存并进入登录
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
