// Vitest global setup（9/14 事故修复，勿删）。
//
// 根因链：Node ≥25 默认启用 webstorage——当 `--localstorage-file` 默认路径
// 无效时，Node 原生 globalThis.localStorage 是一个**坏 stub**（对象存在、
// setItem/getItem 缺失，仅 Object.prototype）。jsdom 29 的 window 与测试
// 全局是同一对象，且其 localStorage 同样指向该 stub（探针实测
// window.localStorage.setItem === undefined）。结果：所有 zustand persist
// store 的测试 `TypeError: storage.setItem is not a function`
//（use-global-matrix-sync / tool-call-counter 等 19 文件 108+ 测试同批
// 失败，与代码改动无关）。
//
// 修法：测试全局装一个最小内存版 Storage（configurable getter 可覆盖），
// 并对每个测试隔离清空。对任意 Node 版本 / flag 组合都成立。

import { afterEach } from 'vitest';

class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

function brokenStorage(value: unknown): boolean {
  return (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { setItem?: unknown }).setItem !== 'function'
  );
}

const current = (globalThis as { localStorage?: unknown }).localStorage;
if (brokenStorage(current)) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  const ls = (globalThis as { localStorage?: MemoryStorage }).localStorage;
  try {
    ls?.clear?.();
  } catch {
    // storage 不可用时忽略
  }
});
