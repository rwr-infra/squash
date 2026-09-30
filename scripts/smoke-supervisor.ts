// Regression smoke for the instance supervisor's state machine, driven through
// the real createInstanceSupervisor + node-pty against a fake child (this Node
// binary running an inline script). Checks:
//   - stop() while the child keeps printing during its shutdown and then exits
//     non-zero ends in `stopped` — never back to `running`, never `crashed` —
//     and is not auto-restarted
//   - dispose() in the same situation does not auto-restart either
//   - a child that exits non-zero on its own is still `crashed` and restarted
//   - a child that exits 0 on its own is `stopped` and not restarted
//   - output keeps updating lastOutputAt
//
// Usage: npm run smoke:supervisor

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstanceSupervisor } from '../src/core/instance/instance-supervisor.js';
import type { InstanceStatus, InstanceSupervisor } from '../src/core/instance/instance-types.js';

const isWindows = process.platform === 'win32';
const RESTART_DELAY_MS = 200;
// Long enough for a wrongly scheduled restart to have fired and spawned.
const RESTART_WINDOW_MS = RESTART_DELAY_MS * 4;

const log = (msg: string) => console.log(`[smoke] ${msg}`);
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every harness cwd/logDir lives under one root, removed on any exit path.
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-supervisor-smoke-'));
process.on('exit', () => {
  try {
    fs.rmSync(workRoot, { recursive: true, force: true });
  } catch {
    // Best-effort: on Windows a still-running child can hold its cwd.
  }
});

// Fake rwr_server. On SIGHUP/SIGTERM (node-pty's POSIX kill) it keeps printing
// for ~200ms and then exits 1 — like a real server logging its shutdown.
// `crash-once` exits 1 on its first run (flag file in cwd) and stays up after
// the restart; `clean` exits 0 on its own.
const CHILD = `
const fs = require('node:fs');
const mode = process.argv[1];
console.log('child ready');
const shutdown = () => {
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    console.log('shutting down ' + n);
    if (n === 5) { clearInterval(timer); process.exit(1); }
  }, 40);
};
process.on('SIGHUP', shutdown);
process.on('SIGTERM', shutdown);
if (mode === 'crash-once' && !fs.existsSync('crashed.flag')) {
  fs.writeFileSync('crashed.flag', '');
  setTimeout(() => process.exit(1), 200);
}
if (mode === 'clean') {
  setTimeout(() => process.exit(0), 200);
}
setInterval(() => {}, 1000);
`;

type Harness = {
  readonly supervisor: InstanceSupervisor;
  readonly statuses: InstanceStatus[];
  // Everything the child printed, across restarts (getRecentOutput() is reset
  // by start()).
  readonly output: () => string;
};

const createHarness = async (mode: string): Promise<Harness> => {
  const cwd = fs.mkdtempSync(path.join(workRoot, `${mode}-`));
  const supervisor = await createInstanceSupervisor({
    id: `smoke-${mode}`,
    name: `smoke-${mode}`,
    cwd,
    executable: process.execPath,
    args: ['-e', CHILD, mode],
    env: {},
    logDir: cwd,
    autoRestart: true,
    restartDelayMs: RESTART_DELAY_MS
  });
  const statuses: InstanceStatus[] = [];
  supervisor.onStatus((runtime) => {
    statuses.push(runtime.status);
  });
  const chunks: string[] = [];
  supervisor.onData((chunk) => {
    chunks.push(chunk);
  });
  return { supervisor, statuses, output: () => chunks.join('') };
};

const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
};

const isSettled = (supervisor: InstanceSupervisor) => {
  const { status } = supervisor.getRuntime();
  return status === 'stopped' || status === 'crashed';
};

// A user stop (or dispose) must end in `stopped` even though the child prints
// while it shuts down and exits non-zero.
const checkUserStop = async (how: 'stop' | 'dispose') => {
  const { supervisor, statuses, output } = await createHarness(`${how}-graceful`);
  await supervisor.start();
  const ready = await waitFor(() => output().includes('child ready'), 5000);
  if (!check(`${how}: child started`, ready, JSON.stringify(output()))) return;
  if (how === 'stop') {
    check('output updates lastOutputAt', supervisor.getRuntime().lastOutputAt !== undefined);
  }

  statuses.length = 0;
  if (how === 'stop') {
    supervisor.stop();
  } else {
    supervisor.dispose();
  }
  await waitFor(() => isSettled(supervisor), 5000);
  await sleep(RESTART_WINDOW_MS);

  const runtime = supervisor.getRuntime();
  if (isWindows) {
    // kill() is `taskkill /T /F` there: no signal, so no shutdown output.
    log(`${how}: skip shutdown-output check on Windows`);
  } else {
    check(`${how}: child printed while stopping`, output().includes('shutting down 5'));
  }
  check(`${how}: ends in stopped`, runtime.status === 'stopped', `status=${runtime.status} exitCode=${runtime.exitCode}`);
  check(
    `${how}: never reported running/crashed after the request`,
    statuses.every((status) => status === 'stopping' || status === 'stopped'),
    statuses.join(' → ')
  );
  check(`${how}: no auto-restart`, runtime.restartCount === 0, `restartCount=${runtime.restartCount}`);
};

// A real crash (non-zero exit without a stop request) must still be `crashed`
// and auto-restarted.
const checkCrashRestarts = async () => {
  const { supervisor, statuses } = await createHarness('crash-once');
  await supervisor.start();
  const restarted = await waitFor(() => {
    const runtime = supervisor.getRuntime();
    return runtime.status === 'running' && runtime.restartCount === 1;
  }, 5000);
  check('crash: reported crashed', statuses.includes('crashed'), statuses.join(' → '));
  check('crash: auto-restarted', restarted, `status=${supervisor.getRuntime().status} restartCount=${supervisor.getRuntime().restartCount}`);
  if (restarted) {
    supervisor.stop();
    await waitFor(() => isSettled(supervisor), 5000);
  }
};

// A clean exit (code 0) is a normal completion: `stopped`, no restart.
const checkCleanExit = async () => {
  const { supervisor, statuses } = await createHarness('clean');
  await supervisor.start();
  await waitFor(() => isSettled(supervisor), 5000);
  await sleep(RESTART_WINDOW_MS);
  const runtime = supervisor.getRuntime();
  check('clean exit: ends in stopped', runtime.status === 'stopped', `status=${runtime.status} exitCode=${runtime.exitCode}`);
  check('clean exit: no auto-restart', !statuses.includes('crashed') && runtime.restartCount === 0, statuses.join(' → '));
};

setTimeout(() => {
  console.error('[smoke] timed out');
  process.exit(1);
}, 30_000).unref();

await checkUserStop('stop');
await checkUserStop('dispose');
await checkCrashRestarts();
await checkCleanExit();

if (failures.length > 0) {
  console.error(`[smoke] ${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
log('all checks passed');
// Leftover PTYs would keep the event loop alive.
process.exit(0);
