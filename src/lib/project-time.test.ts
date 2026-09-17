import { describe, expect, it } from 'vitest';
import { projectTs } from './project-time';

describe('projectTs（多源兜底）', () => {
  it('显式字段优先（updated_at 字符串）', () => {
    const t = projectTs({ project_id: 'proj-20260901-aaa', updated_at: '2026-09-10T08:00:00Z' });
    expect(t).toBe(Date.parse('2026-09-10T08:00:00Z'));
  });

  it('无字段 → project_id 内嵌 YYYYMMDD 近似', () => {
    const t = projectTs({ project_id: 'proj-20260914-bbb' });
    expect(t).toBe(new Date(2026, 8, 14).getTime());
  });

  it('字段与内嵌日期取较晚者', () => {
    const t = projectTs({ project_id: 'proj-20260914-bbb', updated_at: '2026-09-01T00:00:00Z' });
    expect(t).toBe(new Date(2026, 8, 14).getTime());
  });

  it('created_at 兜底（updated_at 缺）', () => {
    const t = projectTs({ project_id: 'p1', created_at: 1757000000000 });
    expect(t).toBe(1757000000000);
  });

  it('全缺 → 0', () => {
    expect(projectTs({ project_id: 'p1' })).toBe(0);
  });
});
