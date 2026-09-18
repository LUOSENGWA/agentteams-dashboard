'use client';

import { useCallback, useEffect, useState } from 'react';

// Worker approval level (Controller `GET/PUT /api/v1/workers/{name}/approval`,
// upstream #1216). Workers only (no manager endpoint). L2 users can read and
// set strict/smart/auto for own-team workers (off requires L1); team leaders
// are read-only.
//
// Status semantics (older / lower-privilege controllers degrade gracefully):
// - 200 → level returned / set
// - 404 → endpoint absent (older Controller) or worker outside team scope
//   (W8) → `off: true`, the UI hides the section
// - 403 → no permission (L2 setting off, or team leader) → `noAccess`
// - 409 → concurrent update conflict → surface the error (retry)

export const APPROVAL_LEVELS = ['STRICT', 'SMART', 'AUTO', 'OFF'] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const APPROVAL_LEVEL_LABELS: Record<ApprovalLevel, string> = {
  STRICT: '严格',
  SMART: '智能',
  AUTO: '自动',
  OFF: '关闭',
};

export interface WorkerApprovalState {
  /** true when the endpoint is absent (older Controller) → hide the section. */
  off: boolean;
  /** true when the caller cannot set levels (team leader / L2 off) → read-only. */
  noAccess: boolean;
  loading: boolean;
  level: ApprovalLevel | null;
  saving: boolean;
  error: string | null;
  setLevel: (_level: ApprovalLevel) => Promise<boolean>;
}

export function useWorkerApproval(
  workerName: string | null,
): WorkerApprovalState {
  const [off, setOff] = useState(false);
  const [noAccess, setNoAccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [level, setLevelState] = useState<ApprovalLevel | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workerName) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/agentteams/workers/${encodeURIComponent(workerName)}/approval`,
          { cache: 'no-store' },
        );
        if (cancelled) return;
        if (res.status === 404) {
          setOff(true);
          setNoAccess(false);
          setLevelState(null);
          return;
        }
        if (res.status === 403) {
          setOff(false);
          setNoAccess(true);
          setLevelState(null);
          return;
        }
        if (!res.ok) {
          setOff(false);
          setNoAccess(false);
          setLevelState(null);
          setError(`加载失败（${res.status}）`);
          return;
        }
        const data = (await res.json()) as { approval_level?: string };
        if (cancelled) return;
        setOff(false);
        setNoAccess(false);
        const raw = String(data.approval_level || 'AUTO').toUpperCase();
        setLevelState((APPROVAL_LEVELS as readonly string[]).includes(raw) ? (raw as ApprovalLevel) : 'AUTO');
      } catch {
        if (!cancelled) {
          setOff(false);
          setNoAccess(false);
          setLevelState(null);
          setError('加载审批级别失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workerName]);

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
        if (res.status === 403) {
          let detail = '无权限设置该级别（L2 不能设关闭；team leader 只读）';
          try {
            const d = (await res.clone().json()) as { detail?: string };
            if (d.detail) detail = d.detail;
          } catch {
            /* ignore */
          }
          setError(detail);
          return false;
        }
        if (!res.ok) {
          let detail = `设置失败（${res.status}）`;
          try {
            const d = (await res.clone().json()) as { detail?: string };
            if (d.detail) detail = d.detail;
          } catch {
            /* ignore */
          }
          setError(detail);
          return false;
        }
        const data = (await res.json()) as { approval_level?: string };
        const raw = String(data.approval_level || next).toUpperCase();
        setLevelState((APPROVAL_LEVELS as readonly string[]).includes(raw) ? (raw as ApprovalLevel) : next);
        return true;
      } catch {
        setError('设置审批级别失败');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [workerName],
  );

  return { off, noAccess, loading, level, saving, error, setLevel };
}
