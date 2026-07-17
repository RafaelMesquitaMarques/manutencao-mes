import { defineConfig } from 'vitest/config';

// Unit tests only (pure stores/utils) — no jsdom needed; browser APIs the code
// touches at module scope (localStorage) are stubbed in the setup file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
});
