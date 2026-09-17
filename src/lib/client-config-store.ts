/**
 * Client-side configuration store (F7 stateless terminal state).
 *
 * `at_cfg` in localStorage mirrors the workbench plugin's config.json fields
 * that a browser-driven deployment needs, field for field:
 *
 *   matrix_homeservers  ← config.json matrix_homeservers (ordered, failover)
 *   controller_urls     ← config.json controller_urls   (ordered, failover)
 *   controller_token    ← config.json controller_token  (optional L1 channel)
 *   sglang              ← config.json sglang            (optional load monitor)
 *
 * The Matrix credential triple (user_id / access_token / device_id) is NOT
 * duplicated here — the dashboard already persists it in the existing
 * `matrix-store` zustand store (same three fields, plugin 1:1).
 *
 * Deliberately NOT stored (plugin flaw not inherited): admin_password.
 * The stateless L1 channel is the controller_token only.
 *
 * SSR-safe: every accessor is a no-op (null / defaults) on the server.
 */

export interface ClientSglangConfig {
  enabled: boolean;
  urls: string[];
}

export interface ClientConfig {
  matrix_homeservers: string[];
  controller_urls: string[];
  controller_token: string;
  sglang: ClientSglangConfig;
}

export const CLIENT_CONFIG_KEY = 'at_cfg';

const DEFAULTS: ClientConfig = {
  matrix_homeservers: [],
  controller_urls: [],
  controller_token: '',
  sglang: { enabled: false, urls: [] },
};

function isBrowser(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

/** Load the client config. Returns null when unconfigured (SSR or no entry). */
export function loadClientConfig(): ClientConfig | null {
  if (!isBrowser()) return null;
  try {
    const raw = localStorage.getItem(CLIENT_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClientConfig>;
    return {
      matrix_homeservers: stringArray(parsed.matrix_homeservers),
      controller_urls: stringArray(parsed.controller_urls),
      controller_token: typeof parsed.controller_token === 'string' ? parsed.controller_token : '',
      sglang: {
        enabled: parsed.sglang?.enabled === true,
        urls: stringArray(parsed.sglang?.urls),
      },
    };
  } catch {
    return null;
  }
}

/** Persist the client config (atomic: single JSON write). */
export function saveClientConfig(cfg: ClientConfig): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(
      CLIENT_CONFIG_KEY,
      JSON.stringify({
        matrix_homeservers: stringArray(cfg.matrix_homeservers),
        controller_urls: stringArray(cfg.controller_urls),
        controller_token: cfg.controller_token ?? '',
        sglang: {
          enabled: cfg.sglang?.enabled === true,
          urls: stringArray(cfg.sglang?.urls),
        },
      }),
    );
  } catch {
    /* storage full / privacy mode — config simply does not persist */
  }
}

/** Shallow-patch the client config (addresses + token + sglang). */
export function updateClientConfig(patch: Partial<Omit<ClientConfig, 'sglang'>> & { sglang?: Partial<ClientSglangConfig> }): ClientConfig {
  const current = loadClientConfig() ?? DEFAULTS;
  const next: ClientConfig = {
    matrix_homeservers: patch.matrix_homeservers ? stringArray(patch.matrix_homeservers) : current.matrix_homeservers,
    controller_urls: patch.controller_urls ? stringArray(patch.controller_urls) : current.controller_urls,
    controller_token:
      patch.controller_token !== undefined ? patch.controller_token : current.controller_token,
    sglang: {
      enabled: patch.sglang?.enabled ?? current.sglang.enabled,
      urls: patch.sglang?.urls ? stringArray(patch.sglang.urls) : current.sglang.urls,
    },
  };
  saveClientConfig(next);
  return next;
}

/** Wipe the client config (logout / "switch account" / device revoke). */
export function clearClientConfig(): void {
  if (!isBrowser()) return;
  try {
    localStorage.removeItem(CLIENT_CONFIG_KEY);
  } catch {
    /* ignore */
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

/**
 * Client-side pre-validation for a candidate address (the server-side
 * allowlist in homeserver-allowlist.ts remains the authoritative check —
 * this only rejects obvious garbage before it is persisted).
 */
export function validateClientAddress(
  url: string,
  kind: 'matrix' | 'controller' | 'sglang',
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return '不是合法的 URL';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return '仅支持 http/https';
  }
  if (!parsed.hostname) return '缺少主机名';
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口非法';
  // Kind-specific sanity: the Matrix Client-Server API lives on a homeserver
  // root; a trailing path is almost always a copy/paste mistake.
  if (kind === 'matrix' && parsed.pathname !== '/' && parsed.pathname !== '') {
    return 'Matrix 地址应为服务器根地址（不带路径）';
  }
  return null;
}
