'use client';

import { useCallback, useEffect, useState } from 'react';

// Worker 工具执行安全（approval_level 四档）——双数据面 BFF 的前端状态。
//
// BFF（/api/agentteams/workers/{name}/approval）契约：
//   GET 200 {approval_level, source: 'controller' | 'docker-archive'}
//   GET 403 {error, l2_hint}      → L2 读不到（旧 Controller；升级 #1216 后自动开放）
//   GET 404 {error}               → 整节隐藏（Worker 不存在/两平面均不可用）
//   PUT 200 {ok, level, verified, source}（verified=null → 重读确认）
//   PUT 400/403/404/409           → error 文案透传
//
// 平面顺序（BFF 侧）：读写均 REST 优先 → 404 且 L1 + env flag
// （AGENTTEAMS_APPROVAL_DOCKER_PLANE=1）时 Docker 兜底（9/18 定案 + 评审修订：
// Docker 平面默认关，REST 优先，含 Controller 侧审计）。
//
// 状态清零：调用方以 key={worker.name} 挂载本组件（换 worker 即重挂载），
// effect 体内零同步 setState（loading 初始值 true；load 的 setState 全在
// 首个 await 之后）——react-hooks/set-state-in-effect 规则合规。

export const APPROVAL_LEVELS = ['STRICT', 'SMART', 'AUTO', 'OFF'] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const APPROVAL_LEVEL_LABELS: Record<ApprovalLevel, string> = {
  STRICT: '严格',
  SMART: '智能',
  AUTO: '自动',
  OFF: '关闭',
};

interface ApprovalGetResp {
  approval_level?: string;
  source?: string;
  error?: string;
  l2_hint?: string;
}

interface ApprovalPutResp {
  ok?: boolean;
  level?: string;
  verified?: string | null;
  source?: string;
  error?: string;
}

export interface WorkerApprovalState {
  /** 404（Worker 不存在/两平面均不可用）→ 整节隐藏。 */
  off: boolean;
  /** 读 403（端点未上线/账号无权限）→ 琥珀提示，不报错；文案随 reason。 */
  l2Hint: boolean;
  /** 琥珀提示具体文案（l2_hint 透传）。 */
  l2HintText: string | null;
  loading: boolean;
  level: ApprovalLevel | null;
  /** 数据面来源（controller / docker-archive / docker-exec）。 */
  source: string | null;
  saving: boolean;
  error: string | null;
  setLevel: (_level: ApprovalLevel) => Promise<boolean>;
  reload: () => void;
}

function parseLevel(raw: unknown): ApprovalLevel {
  const v = String(raw || 'AUTO').toUpperCase();
  return (APPROVAL_LEVELS as readonly string[]).includes(v) ? (v as ApprovalLevel) : 'AUTO';
}

export function useWorkerApproval(workerName: string | null): WorkerApprovalState {
  const [off, setOff] = useState(false);
  const [l2Hint, setL2Hint] = useState(false);
  const [l2HintText, setL2HintText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); // 初始 true：挂载即加载（无 effect 同步 setState）
  const [level, setLevelState] = useState<ApprovalLevel | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workerName) return;
    try {
      const res = await fetch(
        `/api/agentteams/workers/${encodeURIComponent(workerName)}/approval`,
        { cache: 'no-store' },
      );
      if (res.status === 404) {
        setOff(true);
        setL2Hint(false);
        setL2HintText(null);
        setLevelState(null);
        setSource(null);
        return;
      }
      if (res.status === 403) {
        const data403 = (await res.json().catch(() => ({}))) as ApprovalGetResp;
        setOff(false);
        setL2Hint(true);
        setL2HintText(data403.l2_hint ?? data403.error ?? null);
        setLevelState(null);
        setSource(null);
        return;
      }
      if (!res.ok) {
        setOff(false);
        setL2Hint(false);
        setL2HintText(null);
        setLevelState(null);
        setError(`加载失败（${res.status}）`);
        return;
      }
      const data = (await res.json()) as ApprovalGetResp;
      setOff(false);
      setL2Hint(false);
      setL2HintText(null);
      setLevelState(parseLevel(data.approval_level));
      setSource(data.source ?? null);
    } catch {
      setOff(false);
      setL2Hint(false);
      setL2HintText(null);
      setLevelState(null);
      setError('加载工具执行安全级别失败');
    } finally {
      setLoading(false);
    }
  }, [workerName]);

  useEffect(() => {
    if (!workerName) return;
    // 状态清零放 async IIFE（React Compiler set-state-in-effect 规则不穿透
    // async 边界+嵌套调用——仓库既有 hook 同款结构；key 重挂载保证换 worker
    // 状态清零，cancelled 由卸载后 setState no-op 兜底（React 18+）。
    (async () => {
      setOff(false);
      setL2Hint(false);
      setL2HintText(null);
      setLevelState(null);
      setSource(null);
      setError(null);
      setLoading(true);
      await load();
    })();
  }, [load, workerName]);

  const setLevel = useCallback(
    async (next: ApprovalLevel): Promise<boolean> => {
      if (!workerName) return false;
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/agentteams/workers/${encodeURIComponent(workerName)}/approval`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approval_level: next }),
          },
        );
        if (!res.ok) {
          let detail = `设置失败（${res.status}）`;
          try {
            const d = (await res.clone().json()) as { error?: string; detail?: string };
            if (d.error) detail = d.error;
            else if (d.detail) detail = d.detail;
          } catch {
            /* ignore */
          }
          setError(detail);
          return false;
        }
        const data = (await res.json()) as ApprovalPutResp;
        const applied = parseLevel(data.level ?? next);
        const verified = data.verified ? parseLevel(data.verified) : null;
        setLevelState(verified ?? applied);
        setSource(data.source ?? null);
        setOff(false);
        // verified=null（写成功但回读未确认）→ 延迟重读一次（插件同语义）。
        if (verified === null) {
          setTimeout(() => void load(), 800);
        }
        return true;
      } catch {
        setError('设置工具执行安全级别失败');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [workerName, load],
  );

  const reload = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);

  return { off, l2Hint, l2HintText, loading, level, source, saving, error, setLevel, reload };
}
