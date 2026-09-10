// Pure data shared between the server-side backend-config module and
// client components (the setup page). Kept dependency-free on purpose:
// this file is importable from the browser bundle, while backend-config.ts
// uses node:fs and must stay server-only.

export type BackendName =
  | 'controller'
  | 'matrix'
  | 'minio'
  | 'higress-gateway'
  | 'higress-console'
  | 'sglang';

export const BACKEND_NAMES: BackendName[] = [
  'controller',
  'matrix',
  'minio',
  'higress-gateway',
  'higress-console',
  'sglang',
];

/** Backends that must be reachable for the dashboard to be usable at all
 * (login + data plane). Others are optional feature backends. */
export const REQUIRED_BACKENDS: BackendName[] = ['controller', 'matrix'];

/** Embedded topology defaults (same constants the server-side infrastructure
 * probe uses). Used only for the first-launch auto-detect banner. */
export const EMBEDDED_DEFAULTS: Record<BackendName, string | undefined> = {
  controller: 'http://agentteams-controller:8090',
  matrix: 'http://agentteams-controller:6167',
  minio: 'http://agentteams-controller:9000',
  'higress-gateway': 'http://aigw-local.agentteams.io:8080',
  'higress-console': 'http://agentteams-controller:8001',
  sglang: undefined,
};

export const BACKEND_LABELS: Record<BackendName, string> = {
  controller: 'AgentTeams Controller',
  matrix: 'Matrix 服务器',
  minio: 'MinIO 文件存储',
  'higress-gateway': 'Higress AI 网关',
  'higress-console': 'Higress Console',
  sglang: 'SGLang 推理服务（可选）',
};
