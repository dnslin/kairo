import { test } from 'vitest';

test(
  '运行 #131 Mastra 最小合同矩阵',
  async () => {
    // 必须在 Vitest 测试生命周期内加载：Mastra 官方 mock 会读取 worker 上下文。
    await import('./contracts.js');
  },
  300_000
);
