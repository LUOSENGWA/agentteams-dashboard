// 敏感文件过滤（共享定义：server 路由 + client 文件面板）。
// 对齐 workbench 插件 _kb_is_sensitive（agentteams_connector/router.py）：
// 原先 worker-files-panel / room-files-panel 各持一份重复拷贝，
// 知识库 v2（docker-proxy 数据面）server 侧过滤需要同一定义 → 提为共享 lib。
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /^\.hermes\/config\.yaml$/,
  /^\.ssh\//,
  /^credentials\//,
  /^openclaw\.json$/,
  /\.lock$/,
];

/**
 * @param name  文件名（basename）
 * @param rel   相对工作区的路径（如 memory/2026-09-15.md）
 * 任一命中即敏感（插件同款双参语义：顶层文件 name=rel，子目录文件按 rel 判前缀）。
 */
export function isSensitiveFileName(name: string, rel: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(rel) || p.test(name));
}
