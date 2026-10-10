import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// End-to-end tests over build output, apart from `npm test` — and named so
// that the VS Code Vitest extension, which picks up every *vitest*.config*
// file, does not run them either. Each needs something built first, so each
// is its own project, run by its npm script (`npm run smoke:<name>`):
//   - restart-policy: dist/ and frontend/dist (CI runs it after Package)
//   - release: the release archive from `npm run package` (CI runs it last)
//   - instance-form, server-log-ui: frontend/dist built without VITE_* and a
//     local Chrome/Chromium (local only, not in CI)
// Run together, they go one at a time, in this order.
const project = (name: string, groupOrder: number) => ({
  extends: true as const,
  test: {
    name,
    include: [`test/e2e/${name}.test.ts`],
    sequence: { groupOrder }
  }
});

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    // Child processes, not worker threads, as in the root vitest.config.ts:
    // these spawn and signal real processes.
    pool: 'forks',
    projects: [project('restart-policy', 0), project('release', 1), project('instance-form', 2), project('server-log-ui', 3)]
  }
});
