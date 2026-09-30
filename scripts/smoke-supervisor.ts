// Regression smoke for the instance supervisor's state machine, driven through
// the real createInstanceSupervisor + node-pty against a fake child (this Node
// binary running an inline script). Checks:
//   - stop() while the child keeps printing during its shutdown and then exits
//     non-zero ends in `stopped` — never back to `running`, never `crashed` —
//     and is not auto-restarted
//   - dispose() in the same situation does not auto-restart either, and its
//     promise resolves once the process has exited
//   - a child that exits non-zero on its own is still `crashed` and restarted
//   - a child that exits 0 on its own is `stopped` and not restarted
//   - output keeps updating lastOutputAt
//   - the PTY size follows resize(), survives restart(), and a resize while
//     stopped is remembered for the next start()
//   - sendCommand() reaches the child's stdin one line per command, in order
//     (the path a stopCommand takes)
//   - a configured stopCommand is sent line by line instead of a signal, and
//     a child that exits on it (printing while it shuts down) ends `stopped`
//     without a force-kill — on Windows too
//   - a child that ignores the graceful stop is force-killed after
//     stopTimeoutMs, grandchild included, and the instance log says so
//   - Stop while `stopping` leaves the graceful stop alone; Stop with `force`
//     kills at once
//   - a disposed supervisor refuses to start again
//
// Usage: npm run smoke:supervisor

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstanceSupervisor } from '../src/core/instance/instance-supervisor.js';
import type { InstanceConfig, InstanceStatus, InstanceSupervisor } from '../src/core/instance/instance-types.js';
import { toInstanceLogFile } from '../src/core/log/log-writer.js';

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
// Live children and grandchildren a failed check may leave behind (a child
// stuck in `stopping` outlives this script: it ignores the PTY's SIGHUP). A
// PID leaves the set as soon as its process is known to be gone — Windows
// reuses PIDs quickly, and killing a recycled one would hit an unrelated
// process.
const strays = new Set<number>();
process.on('exit', () => {
  for (const pid of strays) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  try {
    fs.rmSync(workRoot, { recursive: true, force: true });
  } catch {
    // Best-effort: on Windows a still-running child can hold its cwd.
  }
});

// Fake rwr_server. On SIGHUP/SIGTERM (node-pty's POSIX kill) it keeps printing
// for ~200ms and then exits 1 — like a real server logging its shutdown.
// `crash-once` exits 1 on its first run (flag file in cwd) and stays up after
// the restart; `clean` exits 0 on its own; `stdin` prints each raw chunk it
// reads and every `\n`-terminated line (the PTY echoes input too, hence the
// `got` marker); `size` prints its terminal size at startup and whenever it
// changes. `stop-command` and `stubborn` report a SIGHUP instead of shutting
// down and print each command line they read, blank ones too; `stop-command` shuts down on
// `quit`, `stubborn` never exits and keeps a grandchild (which ignores SIGHUP
// too) alive, printing its PID. On the windows-latest runner ConPTY resized
// the console but the node child never emitted stdout 'resize', and the public
// getWindowSize() only returns the columns/rows cached by that event — so this
// polls the TTY handle directly (what Node's own _refreshSize() calls; libuv's
// uv_tty_get_winsize, i.e. ioctl / GetConsoleScreenBufferInfo).
const CHILD = `
const fs = require('node:fs');
const mode = process.argv[1];
console.log('child ready');
if (mode === 'size') {
  let last = '';
  const report = () => {
    const winSize = [0, 0];
    process.stdout._handle.getWindowSize(winSize);
    const size = winSize[0] + 'x' + winSize[1];
    if (size !== last) { last = size; console.log('size ' + size); }
  };
  report();
  setInterval(report, 50);
}
if (mode === 'stdin') {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    console.log('raw ' + JSON.stringify(data));
    const lines = (pending + data).split('\\n');
    pending = lines.pop();
    for (const line of lines) {
      console.log('got ' + JSON.stringify(line.replace(/\\r$/, '')));
    }
  });
}
const shutdown = () => {
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    console.log('shutting down ' + n);
    if (n === 5) { clearInterval(timer); process.exit(1); }
  }, 40);
};
const onLines = (handler) => {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    const lines = (pending + data).split(/\\r?\\n/);
    pending = lines.pop();
    for (const line of lines) handler(line);
  });
};
if (mode === 'stop-command' || mode === 'stubborn') {
  process.on('SIGHUP', () => console.log('got SIGHUP'));
  onLines((line) => {
    console.log('got ' + JSON.stringify(line));
    if (mode === 'stop-command' && line === 'quit') shutdown();
  });
} else {
  process.on('SIGHUP', shutdown);
  process.on('SIGTERM', shutdown);
}
if (mode === 'stubborn') {
  const { spawn } = require('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  console.log('grandchild ' + grandchild.pid);
}
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
  // The instance log file (`[squash] ...` lines go only there, not to onData).
  readonly instanceLog: () => string;
};

const createHarness = async (mode: string, overrides: Partial<InstanceConfig> = {}): Promise<Harness> => {
  const cwd = fs.mkdtempSync(path.join(workRoot, `${mode}-`));
  const id = `smoke-${mode}`;
  const supervisor = await createInstanceSupervisor({
    id,
    name: id,
    cwd,
    executable: process.execPath,
    args: ['-e', CHILD, mode],
    env: {},
    logDir: cwd,
    autoRestart: true,
    restartDelayMs: RESTART_DELAY_MS,
    ...overrides
  });
  const statuses: InstanceStatus[] = [];
  let lastPid: number | undefined;
  supervisor.onStatus((runtime) => {
    statuses.push(runtime.status);
    if (!runtime.pid) return;
    if (runtime.status === 'stopped' || runtime.status === 'crashed') {
      strays.delete(runtime.pid);
      return;
    }
    strays.add(runtime.pid);
    // restart() replaces the process without a status for the old one: drop
    // its PID once it is gone.
    const previous = lastPid;
    if (previous !== undefined && previous !== runtime.pid) {
      void waitFor(() => !isAlive(previous), 10_000).then((gone) => {
        if (gone) strays.delete(previous);
      });
    }
    lastPid = runtime.pid;
  });
  const chunks: string[] = [];
  supervisor.onData((chunk) => {
    chunks.push(chunk);
  });
  const logFile = toInstanceLogFile(cwd, id);
  const instanceLog = () => {
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch {
      return '';
    }
  };
  return { supervisor, statuses, output: () => chunks.join(''), instanceLog };
};

const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// The `command` lines a stop-command/stubborn child reports having read.
const commandsRead = (output: string) => Array.from(output.matchAll(/got "([^"]*)"/g), (match) => match[1]);

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
  // What dispose() had achieved when its promise resolved — resolving before
  // the process is gone would still look fine once everything has settled.
  let disposedWith: { readonly status: InstanceStatus; readonly output: string } | undefined;
  if (how === 'stop') {
    supervisor.stop();
  } else {
    void supervisor.dispose().then(() => {
      disposedWith = { status: supervisor.getRuntime().status, output: output() };
    });
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
  check(`${how}: reported stopping first`, statuses[0] === 'stopping', statuses.join(' → '));
  check(`${how}: no auto-restart`, runtime.restartCount === 0, `restartCount=${runtime.restartCount}`);
  if (how === 'dispose') {
    check(
      'dispose: resolves once the process has exited',
      disposedWith?.status === 'stopped' && (isWindows || disposedWith.output.includes('shutting down 5')),
      disposedWith ? `status=${disposedWith.status} at resolve` : 'never resolved'
    );
    let startError = '';
    try {
      await supervisor.start();
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
    }
    check('dispose: a disposed supervisor refuses to start', startError.includes('disposed'), startError || 'start() succeeded');
    if (!startError) {
      supervisor.stop();
      await waitFor(() => isSettled(supervisor), 5000);
    }
  }
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

// The PTY size is whatever a viewer last asked for, across restarts and while
// stopped — not the spawn default once a browser has sent its dimensions.
const checkResize = async () => {
  const { supervisor, output } = await createHarness('size');
  // Only output after `mark` counts, so a size printed by an earlier run can't
  // satisfy a later check.
  let mark = 0;
  const printedSince = (size: string) => waitFor(() => output().slice(mark).includes(`size ${size}`), 5000);

  await supervisor.start();
  check('resize: spawns at the 120x40 default', await printedSince('120x40'), JSON.stringify(output()));

  mark = output().length;
  supervisor.resize(100, 30);
  check('resize: running PTY follows resize()', await printedSince('100x30'), JSON.stringify(output().slice(mark)));

  mark = output().length;
  await supervisor.restart();
  check('resize: restart() keeps the last size', await printedSince('100x30'), JSON.stringify(output().slice(mark)));

  supervisor.stop();
  await waitFor(() => isSettled(supervisor), 5000);
  let resizeError = '';
  try {
    supervisor.resize(90, 20);
  } catch (err) {
    resizeError = err instanceof Error ? err.message : String(err);
  }
  check('resize: while stopped does not throw', resizeError === '', resizeError);

  mark = output().length;
  await supervisor.start();
  check('resize: next start() uses the size set while stopped', await printedSince('90x20'), JSON.stringify(output().slice(mark)));

  supervisor.stop();
  await waitFor(() => isSettled(supervisor), 5000);
};

// A stopCommand is written with sendCommand()'s `<line>\r`: each command must
// reach the child's stdin as its own line, in order — under ConPTY as well.
const checkSendCommand = async () => {
  const { supervisor, output } = await createHarness('stdin');
  await supervisor.start();
  const ready = await waitFor(() => output().includes('child ready'), 5000);
  if (!check('sendCommand: child started', ready, JSON.stringify(output()))) return;

  supervisor.sendCommand('first');
  supervisor.sendCommand('second');
  await waitFor(() => output().includes('got "second"'), 5000);
  const text = output();
  const first = text.indexOf('got "first"');
  const second = text.indexOf('got "second"');
  check('sendCommand: each command arrives as its own line, in order', first !== -1 && second > first, JSON.stringify(text));

  supervisor.stop();
  await waitFor(() => isSettled(supervisor), 5000);
};

// A configured stopCommand replaces the signal: sent line by line (blank lines
// dropped), the child shuts down on its own — printing while it does, which is
// the only way Windows exercises output during `stopping` — and no force-kill
// follows.
const checkStopCommand = async () => {
  const { supervisor, statuses, output, instanceLog } = await createHarness('stop-command', {
    stopCommand: 'save_profiles\n  \nquit',
    stopTimeoutMs: 10_000
  });
  await supervisor.start();
  const ready = await waitFor(() => output().includes('child ready'), 5000);
  if (!check('stopCommand: child started', ready, JSON.stringify(output()))) return;

  statuses.length = 0;
  supervisor.stop();
  await waitFor(() => isSettled(supervisor), 8000);
  await sleep(RESTART_WINDOW_MS);

  const runtime = supervisor.getRuntime();
  const commands = commandsRead(output());
  check('stopCommand: lines sent in order, blank ones dropped', commands.join('|') === 'save_profiles|quit', JSON.stringify(commands));
  // `shutting down 1`, not the last line: whether ConPTY flushes output written
  // right before exit is not what this checks.
  check('stopCommand: child printed while stopping', output().includes('shutting down 1'), JSON.stringify(output().slice(-200)));
  check('stopCommand: no signal sent', !output().includes('got SIGHUP'));
  check('stopCommand: ends in stopped', runtime.status === 'stopped', `status=${runtime.status} exitCode=${runtime.exitCode}`);
  check(
    'stopCommand: never reported running/crashed after the request',
    statuses.every((status) => status === 'stopping' || status === 'stopped'),
    statuses.join(' → ')
  );
  check('stopCommand: no force-kill', !instanceLog().includes('force-killing'), instanceLog());
};

// A child that ignores the graceful stop (SIGHUP, or the stop command) must be
// force-killed once stopTimeoutMs has passed — its grandchild too — and the
// instance log must say why.
const STOP_TIMEOUT_MS = 1000;
const checkStopTimeout = async (via: 'signal' | 'command') => {
  const label = `stop timeout (${via})`;
  const { supervisor, statuses, output, instanceLog } = await createHarness('stubborn', {
    stopTimeoutMs: STOP_TIMEOUT_MS,
    ...(via === 'command' ? { stopCommand: 'quit' } : {})
  });
  await supervisor.start();
  const ready = await waitFor(() => /grandchild \d+/.test(output()) && (supervisor.getRuntime().pid ?? 0) > 0, 5000);
  if (!check(`${label}: child and grandchild started`, ready, JSON.stringify(output()))) return;
  const pid = supervisor.getRuntime().pid!;
  const grandchild = Number(/grandchild (\d+)/.exec(output())![1]);
  strays.add(grandchild);

  statuses.length = 0;
  const stopAt = Date.now();
  supervisor.stop();
  // Precondition: the graceful stop reached the child and it is still alive.
  const ignored = await waitFor(() => output().includes(via === 'signal' ? 'got SIGHUP' : 'got "quit"'), 3000);
  check(
    `${label}: child got the graceful stop and ignored it; grandchild alive`,
    ignored && isAlive(pid) && isAlive(grandchild),
    `${JSON.stringify(output().slice(-200))} grandchild alive=${isAlive(grandchild)}`
  );
  await waitFor(() => isSettled(supervisor), STOP_TIMEOUT_MS + 5000);
  const elapsed = Date.now() - stopAt;
  await sleep(RESTART_WINDOW_MS);

  const runtime = supervisor.getRuntime();
  check(`${label}: ends in stopped`, runtime.status === 'stopped', `status=${runtime.status} after ${elapsed}ms`);
  check(`${label}: waited for stopTimeoutMs first`, elapsed >= STOP_TIMEOUT_MS - 100, `${elapsed}ms`);
  check(
    `${label}: never reported running/crashed after the request`,
    statuses.every((status) => status === 'stopping' || status === 'stopped'),
    statuses.join(' → ')
  );
  check(`${label}: no auto-restart`, runtime.restartCount === 0, `restartCount=${runtime.restartCount}`);
  const logged = await waitFor(() => instanceLog().includes(`stop timed out after ${STOP_TIMEOUT_MS}ms; force-killing`), 2000);
  check(`${label}: instance log records the force-kill`, logged, instanceLog());
  const gone = await waitFor(() => !isAlive(pid) && !isAlive(grandchild), 3000);
  check(`${label}: child and grandchild are gone`, gone, `child alive=${isAlive(pid)} grandchild alive=${isAlive(grandchild)}`);
  if (!isAlive(grandchild)) strays.delete(grandchild);
};

// While `stopping`, a plain Stop (a double click, a stale page) must leave the
// graceful stop alone; only an explicit force stop kills — without waiting out
// the timeout.
const checkForceStop = async () => {
  const { supervisor, output, instanceLog } = await createHarness('stubborn', { stopCommand: 'quit', stopTimeoutMs: 60_000 });
  await supervisor.start();
  const ready = await waitFor(() => /grandchild \d+/.test(output()) && (supervisor.getRuntime().pid ?? 0) > 0, 5000);
  if (!check('force stop: child and grandchild started', ready, JSON.stringify(output()))) return;
  const pid = supervisor.getRuntime().pid!;
  const grandchild = Number(/grandchild (\d+)/.exec(output())![1]);
  strays.add(grandchild);

  supervisor.stop();
  const stopping = await waitFor(() => output().includes('got "quit"'), 3000);
  if (!check('force stop: still stopping after the stop command', stopping && supervisor.getRuntime().status === 'stopping', supervisor.getRuntime().status)) {
    return;
  }

  let repeatError = '';
  try {
    supervisor.stop();
  } catch (err) {
    repeatError = err instanceof Error ? err.message : String(err);
  }
  await sleep(500);
  // Nothing at all: no kill, and no second graceful stop either (resending the
  // command would also restart the timeout, postponing the force-kill).
  const quits = commandsRead(output()).filter((command) => command === 'quit').length;
  const stopLines = instanceLog().split('\n').filter((line) => line.includes('[squash] stopping:')).length;
  check(
    'force stop: a plain Stop while stopping changes nothing',
    repeatError === '' &&
      supervisor.getRuntime().status === 'stopping' &&
      isAlive(pid) &&
      !instanceLog().includes('force-killing') &&
      quits === 1 &&
      stopLines === 1,
    `error=${repeatError || '-'} status=${supervisor.getRuntime().status} alive=${isAlive(pid)} quits=${quits} stopLines=${stopLines}`
  );
  check('force stop: grandchild alive before the force stop', isAlive(grandchild));

  const forceAt = Date.now();
  let forceError = '';
  try {
    supervisor.stop({ force: true });
  } catch (err) {
    forceError = err instanceof Error ? err.message : String(err);
  }
  check('force stop: accepted while stopping', forceError === '', forceError);
  await waitFor(() => isSettled(supervisor), 5000);
  const elapsed = Date.now() - forceAt;
  const runtime = supervisor.getRuntime();
  check('force stop: ends in stopped at once', runtime.status === 'stopped' && elapsed < 5000, `status=${runtime.status} after ${elapsed}ms`);
  const logged = await waitFor(() => instanceLog().includes('force stop requested'), 2000);
  check('force stop: instance log records it', logged, instanceLog());
  check('force stop: child and grandchild are gone', await waitFor(() => !isAlive(pid) && !isAlive(grandchild), 3000));
  if (!isAlive(grandchild)) strays.delete(grandchild);
};

// All checks take ~15s on macOS and roughly twice that on the Windows runner;
// a failing check waits out its timeouts, so leave room for the rest to run.
setTimeout(() => {
  console.error('[smoke] timed out');
  process.exit(1);
}, 90_000).unref();

await checkUserStop('stop');
await checkUserStop('dispose');
await checkCrashRestarts();
await checkCleanExit();
await checkResize();
await checkSendCommand();
await checkStopCommand();
if (isWindows) {
  // No signals on Windows: without a stopCommand, stop is an immediate taskkill.
  log('skip stop timeout (signal) on Windows');
} else {
  await checkStopTimeout('signal');
}
await checkStopTimeout('command');
await checkForceStop();

if (failures.length > 0) {
  console.error(`[smoke] ${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
log('all checks passed');
// Leftover PTYs would keep the event loop alive.
process.exit(0);
