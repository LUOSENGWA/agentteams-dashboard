// Builtin channel field templates for the worker channel panel.
//
// Why this file exists: `GET /api/config/channels/schemas` (upstream
// #1219, proxied by the dashboard route) returns config_fields for
// **plugin-registered channels only** — the QwenPaw server has no
// server-side form schema for builtin channels (registry.py
// `_BUILTIN_SPECS: dict[str, tuple[str, str]]` = (module, class) only).
// The QwenPaw console renders builtin forms via per-channel hardcoded
// antd forms (Control/Channels/components/ChannelDrawer.tsx, ~276
// Form.Items); this table is the dashboard's single-source equivalent,
// field-for-field derived from the pydantic models (QwenPaw
// src/qwenpaw/config/config.py @a43300a1). The dashboard keeps the
// "no per-channel render code" philosophy: one data table, one generic
// renderer, unknown/future fields fall through to type inference.
//
// If QwenPaw adds a channel field, the worst case is the field renders
// via inference (value-driven type) after a config save; update the
// table to give it a proper type/label.
//
// Server stays authoritative: missing optional fields use pydantic
// defaults on PUT; invalid values surface as upstream 400/422 detail.

export type ChannelFieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'switch'
  | 'select'
  | 'list'
  | 'json';

export interface ChannelFieldSpec {
  name: string;
  type: ChannelFieldType;
  /** select options (dm_policy / group_policy / domain). */
  options?: string[];
}

// BaseChannelConfig (config.py:291) — field order = pydantic order.
// Rendered in three blocks: head (enabled/bot_prefix), channel extras,
// access control, display.
const BASE_HEAD: ChannelFieldSpec[] = [
  { name: 'enabled', type: 'switch' },
  { name: 'bot_prefix', type: 'text' },
];

const BASE_ACCESS: ChannelFieldSpec[] = [
  { name: 'dm_policy', type: 'select', options: ['open', 'allowlist'] },
  { name: 'group_policy', type: 'select', options: ['open', 'allowlist'] },
  { name: 'allow_from', type: 'list' },
  { name: 'deny_message', type: 'text' },
  { name: 'require_mention', type: 'switch' },
  { name: 'no_text_debounce', type: 'switch' },
  { name: 'access_control_dm', type: 'switch' },
  { name: 'access_control_group', type: 'switch' },
  { name: 'dm_disabled', type: 'switch' },
  { name: 'group_disabled', type: 'switch' },
];

const BASE_DISPLAY: ChannelFieldSpec[] = [
  { name: 'show_tool_calls', type: 'switch' },
  { name: 'show_tool_results', type: 'switch' },
  { name: 'tool_call_max_length', type: 'number' },
  { name: 'tool_result_max_length', type: 'number' },
  { name: 'show_thinking', type: 'switch' },
];

// Per-channel extra fields, pydantic definition order.
// Keys = the 18 builtin channel keys (registry.py _BUILTIN_SPECS).
const CHANNEL_EXTRA: Record<string, ChannelFieldSpec[]> = {
  imessage: [
    { name: 'db_path', type: 'text' },
    { name: 'poll_sec', type: 'number' },
    { name: 'media_dir', type: 'text' },
  ],
  discord: [
    { name: 'bot_token', type: 'password' },
    { name: 'http_proxy', type: 'text' },
    { name: 'http_proxy_auth', type: 'password' },
    { name: 'accept_bot_messages', type: 'switch' },
    { name: 'streaming_enabled', type: 'switch' },
    { name: 'media_dir', type: 'text' },
  ],
  dingtalk: [
    { name: 'client_id', type: 'text' },
    { name: 'client_secret', type: 'password' },
    { name: 'message_type', type: 'text' },
    { name: 'cron_message_type', type: 'text' },
    { name: 'card_template_id', type: 'text' },
    { name: 'card_template_key', type: 'text' },
    { name: 'robot_code', type: 'text' },
    { name: 'media_dir', type: 'text' },
    { name: 'card_auto_layout', type: 'switch' },
    { name: 'at_sender_on_reply', type: 'switch' },
    { name: 'streaming_enabled', type: 'switch' },
    { name: 'share_session_in_group', type: 'switch' },
    { name: 'endpoint', type: 'text' },
  ],
  feishu: [
    { name: 'app_id', type: 'text' },
    { name: 'app_secret', type: 'password' },
    { name: 'encrypt_key', type: 'password' },
    { name: 'verification_token', type: 'password' },
    { name: 'media_dir', type: 'text' },
    { name: 'domain', type: 'select', options: ['feishu', 'lark'] },
    { name: 'streaming_enabled', type: 'switch' },
    { name: 'share_session_in_group', type: 'switch' },
  ],
  qq: [
    { name: 'app_id', type: 'text' },
    { name: 'client_secret', type: 'password' },
    { name: 'markdown_enabled', type: 'switch' },
    { name: 'max_reconnect_attempts', type: 'number' },
    { name: 'ack_message', type: 'text' },
  ],
  telegram: [
    { name: 'bot_token', type: 'password' },
    { name: 'base_url', type: 'text' },
    { name: 'http_proxy', type: 'text' },
    { name: 'http_proxy_auth', type: 'password' },
    { name: 'show_typing', type: 'switch' },
    { name: 'streaming_enabled', type: 'switch' },
  ],
  mattermost: [
    { name: 'url', type: 'text' },
    { name: 'bot_token', type: 'password' },
    { name: 'media_dir', type: 'text' },
    { name: 'show_typing', type: 'switch' },
    { name: 'thread_follow_without_mention', type: 'switch' },
  ],
  mqtt: [
    { name: 'host', type: 'text' },
    { name: 'port', type: 'number' },
    { name: 'transport', type: 'text' },
    { name: 'clean_session', type: 'switch' },
    { name: 'qos', type: 'number' },
    { name: 'username', type: 'text' },
    { name: 'password', type: 'password' },
    { name: 'subscribe_topic', type: 'text' },
    { name: 'publish_topic', type: 'text' },
    { name: 'tls_enabled', type: 'switch' },
    { name: 'tls_ca_certs', type: 'text' },
    { name: 'tls_certfile', type: 'text' },
    { name: 'tls_keyfile', type: 'text' },
  ],
  console: [{ name: 'media_dir', type: 'text' }],
  matrix: [
    { name: 'homeserver', type: 'text' },
    { name: 'user_id', type: 'text' },
    { name: 'access_token', type: 'password' },
    { name: 'group_allow_from', type: 'list' },
    { name: 'groups', type: 'json' },
    { name: 'encryption', type: 'switch' },
    { name: 'vision_enabled', type: 'switch' },
    { name: 'history_limit', type: 'number' },
    { name: 'password', type: 'password' },
    { name: 'device_name', type: 'text' },
    { name: 'sync_timeout_ms', type: 'number' },
    { name: 'mention_pill_in_body', type: 'switch' },
    { name: 'outbound_structured_mentions', type: 'switch' },
    { name: 'streaming_enabled', type: 'switch' },
    { name: 'share_session_in_group', type: 'switch' },
  ],
  slack: [
    { name: 'bot_token', type: 'password' },
    { name: 'app_token', type: 'password' },
    { name: 'proxy', type: 'text' },
    { name: 'streaming_enabled', type: 'switch' },
    { name: 'media_dir', type: 'text' },
  ],
  voice: [
    { name: 'twilio_account_sid', type: 'text' },
    { name: 'twilio_auth_token', type: 'password' },
    { name: 'phone_number', type: 'text' },
    { name: 'phone_number_sid', type: 'text' },
    { name: 'tts_provider', type: 'text' },
    { name: 'tts_voice', type: 'text' },
    { name: 'stt_provider', type: 'text' },
    { name: 'language', type: 'text' },
    { name: 'welcome_greeting', type: 'text' },
  ],
  sip: [
    { name: 'sip_mode', type: 'text' },
    { name: 'sip_host', type: 'text' },
    { name: 'sip_port', type: 'number' },
    { name: 'sip_username', type: 'text' },
    { name: 'sip_password', type: 'password' },
    { name: 'sip_server', type: 'text' },
    { name: 'sip_transport', type: 'text' },
    { name: 'rtp_port_low', type: 'number' },
    { name: 'rtp_port_high', type: 'number' },
    { name: 'dashscope_api_key', type: 'password' },
    { name: 'tts_provider', type: 'text' },
    { name: 'tts_voice', type: 'text' },
    { name: 'stt_provider', type: 'text' },
    { name: 'language', type: 'text' },
    { name: 'welcome_greeting', type: 'text' },
    { name: 'call_timeout', type: 'number' },
    { name: 'livekit_url', type: 'text' },
    { name: 'livekit_api_key', type: 'password' },
    { name: 'livekit_api_secret', type: 'password' },
    { name: 'livekit_sip_trunk_id', type: 'text' },
    { name: 'livekit_room_name', type: 'text' },
    { name: 'livekit_output_sample_rate', type: 'number' },
    { name: 'max_concurrent_calls', type: 'number' },
  ],
  wecom: [
    { name: 'bot_id', type: 'text' },
    { name: 'secret', type: 'password' },
    { name: 'ws_url', type: 'text' },
    { name: 'media_dir', type: 'text' },
    { name: 'welcome_text', type: 'text' },
    { name: 'share_session_in_group', type: 'switch' },
    { name: 'max_reconnect_attempts', type: 'number' },
    { name: 'streaming_enabled', type: 'switch' },
  ],
  xiaoyi: [
    { name: 'ak', type: 'text' },
    { name: 'sk', type: 'password' },
    { name: 'agent_id', type: 'text' },
    { name: 'ws_url', type: 'text' },
    { name: 'task_timeout_ms', type: 'number' },
  ],
  yuanbao: [
    { name: 'app_id', type: 'text' },
    { name: 'app_secret', type: 'password' },
    { name: 'api_domain', type: 'text' },
    { name: 'ws_url', type: 'text' },
    { name: 'media_dir', type: 'text' },
    { name: 'accept_bot_messages', type: 'switch' },
  ],
  wechat: [
    { name: 'bot_token', type: 'password' },
    { name: 'bot_token_file', type: 'text' },
    { name: 'base_url', type: 'text' },
    { name: 'media_dir', type: 'text' },
    { name: 'message_merge_enabled', type: 'switch' },
    { name: 'message_merge_delay_ms', type: 'number' },
  ],
  onebot: [
    { name: 'ws_host', type: 'text' },
    { name: 'ws_port', type: 'number' },
    { name: 'access_token', type: 'password' },
    { name: 'share_session_in_group', type: 'switch' },
    { name: 'media_dir', type: 'text' },
    { name: 'media_base64', type: 'switch' },
    { name: 'media_base64_max_mb', type: 'number' },
    { name: 'media_download_max_mb', type: 'number' },
  ],
};

// API metadata added by `GET /channels` (config.py list_channels) —
// never part of the PUT body (the console strips it before save too).
export const IS_BUILTIN_KEY = 'isBuiltin';

// Name hints for inferring secret fields on unknown/future fields.
const SECRET_HINTS = ['secret', 'token', 'password', '_key', 'auth'];

export function inferFieldType(value: unknown): ChannelFieldType {
  if (typeof value === 'boolean') return 'switch';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'list';
  if (value !== null && typeof value === 'object') return 'json';
  return 'text';
}

export function isSecretName(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_HINTS.some((h) => n.includes(h));
}

/**
 * Ordered field list for the panel's generic renderer:
 * head (enabled/bot_prefix) → channel extras (pydantic order) →
 * access control → display → unknown saved keys (inferred, sorted).
 * `isBuiltin` is never a field.
 */
export function buildChannelFields(
  channelName: string,
  saved: Record<string, unknown> | undefined,
): ChannelFieldSpec[] {
  const extras = CHANNEL_EXTRA[channelName] ?? [];
  const out: ChannelFieldSpec[] = [...BASE_HEAD, ...extras, ...BASE_ACCESS, ...BASE_DISPLAY].map(
    (f) => ({ ...f }),
  );
  const seen = new Set(out.map((f) => f.name));
  const unknownKeys = Object.keys(saved ?? {})
    .filter((k) => k !== IS_BUILTIN_KEY && !seen.has(k))
    .sort();
  for (const k of unknownKeys) {
    const type = inferFieldType((saved as Record<string, unknown>)[k]);
    out.push({
      name: k,
      type: type === 'text' && isSecretName(k) ? 'password' : type,
    });
  }
  return out;
}

/** app_id → "App Id" (label fallback; raw name still shown small). */
export function humanizeFieldName(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
