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
    // B1（维护者 1.2.4 联调验收报告）：credentials.yaml 独立凭证文件
    // （不在 credentials/ 目录下）必须过滤——插件侧已同步补规则
    ['credentials.yaml', 'credentials.yaml'],
    ['credentials.yml', 'credentials.yml'],
    ['credentials.yaml', 'secrets/credentials.yaml'],
  ])('敏感：name=%s rel=%s → true', (name, rel) => {
    expect(isSensitiveFileName(name, rel)).toBe(true);
  });

  it.each([
    ['MEMORY.md', 'MEMORY.md'],
    ['a.md', 'memory/2026-09-15.md'],
    ['agent.json', 'agent.json'],
    ['notes.md', 'digest/notes.md'],
    // 近似名不放行（模式精确匹配，不误伤）
    ['my-credentials.yaml', 'my-credentials.yaml'],
    ['crednotes.md', 'digest/crednotes.md'],
  ])('放行：name=%s rel=%s → false', (name, rel) => {
    expect(isSensitiveFileName(name, rel)).toBe(false);
  });
});
