import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@kkbot/driver': path.resolve(__dirname, 'packages/driver/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    include: ['packages/driver/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/driver/src/**/*.ts'],
      exclude: ['packages/driver/src/types/**', 'packages/driver/**/*.d.ts'],
    },
  },
});
