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
  ])('敏感：name=%s rel=%s → true', (name, rel) => {
    expect(isSensitiveFileName(name, rel)).toBe(true);
  });

  it.each([
    ['MEMORY.md', 'MEMORY.md'],
    ['a.md', 'memory/2026-09-15.md'],
    ['agent.json', 'agent.json'],
    ['notes.md', 'digest/notes.md'],
    ['credentials', 'credentials'], // 顶层目录条目本身（无斜杠）不过滤——展开才过滤内容（插件同款语义）
  ])('放行：name=%s rel=%s → false', (name, rel) => {
    expect(isSensitiveFileName(name, rel)).toBe(false);
  });
});
