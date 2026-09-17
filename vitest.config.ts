import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 本环境 ambient NODE_ENV=production（容器继承）→ vitest worker 加载 React
// 生产构建，而 `act` 是 dev/test-only API（生产构建剥掉）→ 322 个
// "React.act is not a function" 批量失败（2026-09-16 实测）。这里强制
// test 语义，worker 继承本进程 env，不受 ambient 值影响。
process.env.NODE_ENV = 'test';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      react: path.resolve(__dirname, './node_modules/react'),
      'react-dom': path.resolve(__dirname, './node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(__dirname, './node_modules/react/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.resolve(__dirname, './node_modules/react/jsx-dev-runtime.js'),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    // Node ≥25 webstorage 坏 stub 遮蔽 jsdom localStorage → persist store
    // 测试批量失败；setup 把 jsdom 真 Storage 挂回 globalThis（见文件头注释）。
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/__tests__/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/lib/theme/**',
        'src/lib/plugins/**',
        'src/lib/section-store.ts',
        'src/plugins/**',
        'src/components/theme/**',
        'src/components/plugins/**',
      ],
    },
  },
});
