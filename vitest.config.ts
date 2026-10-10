import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Child processes, not worker threads: node-pty is a native addon, and the
    // supervisor tests spawn and signal real processes.
    pool: 'forks',
    // `npm run test:coverage`: the backend source, also the files no test
    // imports. lcov (coverage/lcov.info) is what CI uploads to Codecov.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov']
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          sequence: { groupOrder: 0 }
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // One file at a time, and only after the unit project has finished,
          // as the smokes these replace ran: the supervisor tests are
          // timing-sensitive, and the line index measures event-loop stalls.
          fileParallelism: false,
          sequence: { groupOrder: 1 },
          testTimeout: 30_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
});
