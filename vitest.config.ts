import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Live-network tests (Braga, mainnet RPC) are opt-in via RUN_LIVE=1.
    testTimeout: 30_000,
  },
});
