'use client';

// Model selection single source of truth (same-source single-implementation
// rule): providers + routes → buildModelSelectionOptions, plus an explicit
// "alias group unavailable" signal.
//
// Why the signal exists (F9②/F10, dashboard alias issue): the Higress
// Console session (_hi_sess) is validated server-side per request. When it is
// missing/expired, both queries below fail (401 "A valid Higress Console
// session is required" / 503 configuration error) and `data` is undefined —
// the old call sites fell back to `?? []` and rendered a builtins-only
// selector with no explanation (the user-visible "only the 16 built-in
// aliases" symptom). Consumers must surface the reason + the way out instead
// of silently degrading.
import { useMemo } from 'react';
import { useModels, useAiRoutes } from '@/hooks/use-agentteams-models';
import {
  buildModelSelectionOptions,
  type ModelSelectionOption,
} from '@/lib/model-catalog';
import type { AiRoute, LlmProviderResponse } from '@/lib/higress-api';

export interface ModelSelection {
  options: ModelSelectionOption[];
  // Raw data for callers that also need binding-level checks
  // (buildModelBindings / hasUnavailableModelAliases submit guards).
  providers: LlmProviderResponse[];
  aiRoutes: AiRoute[];
  isLoading: boolean;
  // Set when the Higress data could not be loaded (console session invalid,
  // console unreachable, or misconfigured). Actionable wording for the UI;
  // null = data loaded (alias group reflects the real gateway state).
  sessionIssue: string | null;
}

export function useModelSelection(): ModelSelection {
  const models = useModels();
  const routes = useAiRoutes();
  const providers = models.data ?? [];
  const aiRoutes = routes.data ?? [];
  const options = useMemo(
    () => buildModelSelectionOptions(aiRoutes, providers),
    [aiRoutes, providers],
  );
  const error = (models.error ?? routes.error) as Error | null;
  return {
    options,
    providers,
    aiRoutes,
    isLoading: models.isLoading || routes.isLoading,
    sessionIssue: error ? error.message || '加载 Higress 模型数据失败' : null,
  };
}
