import { defineConfig } from 'vitest/config';

// End-to-end suite: real Docker, real runs of examples/hello-target. Run through scripts/e2e.sh.
export default defineConfig({
  test: {
    root: '/opt/dexter-bench-lab/cli',
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 45 * 60_000,
    hookTimeout: 45 * 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
