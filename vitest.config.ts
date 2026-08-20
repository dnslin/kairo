import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@kkbot/driver': path.resolve(__dirname, 'packages/driver/src/index.ts'),
      '@kkbot/store': path.resolve(__dirname, 'packages/store/src/index.ts'),
      '@kkbot/gateway': path.resolve(__dirname, 'packages/gateway/src/index.ts'),
      '@kkbot/coordinator': path.resolve(__dirname, 'packages/gateway/src/index.ts'),
      '@kkbot/agent': path.resolve(__dirname, 'packages/agent/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/types/**', 'packages/**/*.d.ts'],
    },
  },
});
