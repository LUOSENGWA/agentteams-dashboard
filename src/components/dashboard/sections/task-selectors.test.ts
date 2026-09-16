import { describe, it, expect } from 'vitest';
import { isStaleProjectSelection } from './task-selectors';

describe('isStaleProjectSelection', () => {
  it('null（未显式选择）永不 stale', () => {
    expect(isStaleProjectSelection(null, ['p1', 'p2'])).toBe(false);
  });

  it('board 加载中（空列表）不误清合法存储值', () => {
    expect(isStaleProjectSelection('p9', [])).toBe(false);
  });

  it('选中项还在看板中 → 不 stale', () => {
    expect(isStaleProjectSelection('p1', ['p1', 'p2'])).toBe(false);
  });

  it('选中项已不在看板（项目被删/改名）→ stale', () => {
    expect(isStaleProjectSelection('p9', ['p1', 'p2'])).toBe(true);
  });
});
