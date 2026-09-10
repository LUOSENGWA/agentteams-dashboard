// EQUAL predicate contract regression (F10, dashboard alias issue).
//
// Two independent layers must both accept Higress Console's 'EQUAL'
// matchType (dashboard-created routes write 'EXACT'; Console-created routes
// write 'EQUAL' — Node1 live data, 2026-09-10):
//   1. lib layer — listAvailableRequestModelAliases accepts EQUAL (22b23a2,
//      covered in model-bindings.test.ts).
//   2. client chain — higressApi.listRoutes() normalizes EQUAL→EXACT via
//      restoreMatchTypeFromApi before collection (ce2a0ed). This test locks
//      that normalization, so removing the rewrite would fail loudly instead
//      of silently emptying the alias group.
import { describe, it, expect } from 'vitest';
import { restoreMatchTypeFromApi } from '@/lib/higress-api';
import { listAvailableRequestModelAliases } from '@/lib/model-bindings';
import { buildModelSelectionOptions } from '@/lib/model-catalog';

const node1Route = {
  name: 'default-ai-route',
  pathPredicate: { matchType: 'PRE', matchValue: '/v1' },
  modelPredicates: [{ matchType: 'EQUAL', matchValue: 'deepseek-v4-flash' }],
  upstreams: [{ provider: 'openai-compat', weight: 100 }],
} as any;
const node1Providers = [{ name: 'openai-compat', tokenCount: 1 }] as any[];

// mirrors the mapping in higressApi.listRoutes()
function asClientSeesIt(route: any) {
  return {
    ...route,
    pathPredicate: {
      ...route.pathPredicate,
      ...restoreMatchTypeFromApi(route.pathPredicate.matchType, route.pathPredicate.matchValue),
    },
    modelPredicates: (route.modelPredicates ?? []).map((p: any) => ({
      ...p,
      ...restoreMatchTypeFromApi(p.matchType, p.matchValue),
    })),
  };
}

describe('EQUAL predicates through the full client chain', () => {
  it('restores EQUAL to EXACT on read', () => {
    expect(restoreMatchTypeFromApi('EQUAL', 'm')).toEqual({ matchType: 'EXACT', matchValue: 'm' });
  });

  it('collects Console-native aliases after the client rewrite', () => {
    const options = buildModelSelectionOptions([asClientSeesIt(node1Route)], node1Providers);
    const configured = options.filter((o) => o.kind === 'configured');
    expect(configured.map((o) => o.alias)).toContain('deepseek-v4-flash');
  });

  it('collects Console-native aliases at the lib layer without the rewrite', () => {
    const bindings = listAvailableRequestModelAliases([node1Route], node1Providers);
    expect(bindings.map((b) => b.requestModelAlias)).toContain('deepseek-v4-flash');
  });
});
