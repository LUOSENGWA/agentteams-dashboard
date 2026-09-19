import { describe, expect, it } from 'vitest';
import { isSensitiveFileName } from './sensitive-files';

describe('sensitive-files（对齐 workbench 插件 _kb_is_sensitive）', () => {
  it.each([
    ['openclaw.json', 'openclaw.json'],
    ['foo.lock', 'foo.lock'],
    ['foo.lock', 'memory/foo.lock'],
    ['id_rsa', '.ssh/id_rsa'],
    ['config.yaml', '.hermes/config.yaml'],
    ['x.yaml', 'credentials/x.yaml'],
    // 插件 _kb_is_sensitive 实码（9/16 对照 router.py L2415-2425）：
    // rel == "credentials"（目录条目本身）同样过滤
    ['credentials', 'credentials'],
  ])('敏感：name=%s rel=%s → true', (name, rel) => {
    expect(isSensitiveFileName(name, rel)).toBe(true);
  });

  it.each([
    ['MEMORY.md', 'MEMORY.md'],
    ['a.md', 'memory/2026-09-15.md'],
    ['agent.json', 'agent.json'],
    ['notes.md', 'digest/notes.md'],
    // credentials.yaml（顶层文件，非 credentials 目录）插件不过滤
    ['credentials.yaml', 'credentials.yaml'],
  ])('放行：name=%s rel=%s → false', (name, rel) => {
    expect(isSensitiveFileName(name, rel)).toBe(false);
  });
});
