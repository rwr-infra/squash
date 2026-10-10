// The instance supervisor's state machine, driven through the real
// createInstanceSupervisor + node-pty against a fake child (this Node binary
// running an inline script).
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
//   - a configured stopCommand is sent line by line instead of a signal (a
//     blank line as a bare Enter), and a child that exits on it (printing
//     while it shuts down) ends `stopped` without a force-kill — on Windows
//     too; a child that, like rwr_server, answers `quit` with "Exit requested"
//     and exits only on the next Enter is stopped by `quit` + an empty line
//   - a child that ignores the graceful stop is force-killed after
//     stopTimeoutMs, grandchild included, and the instance log says so
//   - Stop while `stopping` leaves the graceful stop alone; Stop with `force`
//     kills at once
//   - a disposed supervisor refuses to start again
//   - restart() starts the new process only after the old one has exited —
//     also when called while a stop is under way — and a Stop, force stop or
//     dispose() meanwhile cancels the restart instead of starting a new
//     process; concurrent restarts join into one
//
// Each scenario runs once, in its suite's beforeAll, and records its checks
// as it goes — the observations are timing-sensitive, so they are taken at
// the moment the scenario reaches them, and a scenario that cannot go on
// returns early. Every check is then one test, named by its label, asserting
// what was recorded. A scenario must list its labels up front (scenario()
// throws on a check it did not declare).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInstanceSupervisor, resolveRestartPolicy } from '../../src/core/instance/instance-supervisor.js';
import { CreateInstanceSchema } from '../../src/api/http/schemas/instance-schemas.js';
import type { InstanceConfig, InstanceStatus, InstanceSupervisor } from '../../src/core/instance/instance-types.js';
import { toInstanceLogFile } from '../../src/core/log/log-writer.js';
import { useTempDir } from '../helpers/temp-dir.js';

const isWindows = process.platform === 'win32';
const RESTART_DELAY_MS = 200;
// Long enough for a wrongly scheduled restart to have fired and spawned.
const RESTART_WINDOW_MS = RESTART_DELAY_MS * 4;
// The smoke these tests replace failed when the whole run took longer.
const TOTAL_LIMIT_MS = 240_000;

const log = (msg: string) => console.log(msg);

type CheckResult = { readonly label: string; readonly ok: boolean; readonly detail: string };
// Where each declared label records — by label, unique across the file — so a
// check lands in its own scenario's results even when it runs late (after its
// scenario's beforeAll timed out and the next scenario began).
const recorders = new Map<string, { readonly results: CheckResult[]; readonly skip: boolean }>();
const check = (label: string, ok: boolean, detail = '') => {
  const recorder = recorders.get(label);
  if (!recorder) throw new Error(`check "${label}" is not declared by any scenario`);
  if (recorder.skip) throw new Error(`check "${label}" is declared as skipped on this platform`);
  if (recorder.results.some((result) => result.label === label)) throw new Error(`check "${label}" recorded twice`);
  recorder.results.push({ label, ok, detail });
  return ok;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every harness cwd/logDir lives under one root.
const workRoot = useTempDir('squash-supervisor-test-');
// Live children and grandchildren a failed check may leave behind (a child
// stuck in `stopping` outlives the file: it ignores the PTY's SIGHUP). A
// PID leaves the set as soon as its process is known to be gone — Windows
// reuses PIDs quickly, and killing a recycled one would hit an unrelated
// process. Killed in the afterAll at the end of the file.
const strays = new Set<number>();
const killStrays = () => {
  for (const pid of strays) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
};
// Every supervisor created, for the afterAll at the end of the file.
const supervisors = new Set<InstanceSupervisor>();
let closing = false;
let startedAt = 0;
beforeAll(() => {
  startedAt = Date.now();
});
// Should the afterAll never run (the process exits first), the strays still go.
process.on('exit', killStrays);

// Fake rwr_server. On SIGHUP/SIGTERM (node-pty's POSIX kill) it keeps printing
// for ~200ms and then exits 1 — like a real server logging its shutdown.
// `crash-once` exits 1 on its first run (flag file in cwd) and stays up after
// the restart; `clean` exits 0 on its own; `stdin` prints each raw chunk it
// reads and every `\n`-terminated line (the PTY echoes input too, hence the
// `got` marker); `size` prints its terminal size at startup and whenever it
// changes. `stop-command` and `stubborn` report a SIGHUP instead of shutting
// down and print each command line they read, blank ones too; `stop-command` shuts down on
// `quit`; `exit-requested` answers `quit` like rwr_server does and shuts down
// on the next line — one that arrives at least 300ms after its prompt: input
// already waiting when it prompts is ignored, as a server that flushes its
// input buffer would; `stubborn` never exits and keeps a grandchild (which
// ignores SIGHUP too) alive, printing its PID. On the windows-latest runner ConPTY resized
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
if (mode === 'stop-command' || mode === 'stubborn' || mode === 'exit-requested') {
  process.on('SIGHUP', () => console.log('got SIGHUP'));
  let exitRequestedAt = 0;
  onLines((line) => {
    console.log('got ' + JSON.stringify(line));
    if (mode === 'stop-command' && line === 'quit') shutdown();
    if (mode === 'exit-requested') {
      if (!exitRequestedAt) {
        if (line === 'quit') { exitRequestedAt = Date.now(); console.log('Exit requested'); }
      } else if (Date.now() - exitRequestedAt >= 300) {
        shutdown();
      } else {
        console.log('early line ignored');
      }
    }
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
if (mode === 'clean-once' && !fs.existsSync('crashed.flag')) {
  fs.writeFileSync('crashed.flag', '');
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
  // A scenario still running after its beforeAll timed out must not start a
  // child the cleanup at the end of the file has already gone past.
  if (closing) throw new Error('the file is shutting down');
  const cwd = fs.mkdtempSync(path.join(workRoot(), `${mode}-`));
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
  supervisors.add(supervisor);
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
    // Belt and braces for a replaced process whose own `stopped` was missed:
    // drop its PID once it is gone.
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
    // A stubborn child spawns a grandchild on every start, restarts included.
    // Matched on whole lines of the full output: a chunk may end mid-PID.
    for (const match of chunks.join('').matchAll(/grandchild (\d+)\r?\n/g)) strays.add(Number(match[1]));
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
  const { supervisor, statuses, output } = await createHarness(`${how}-graceful`, { restartPolicy: 'always' });
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

const checkRestartPolicies = async () => {
  const legacy = { autoRestart: true } as InstanceConfig;
  check('policy: legacy enabled maps to on-failure', resolveRestartPolicy(legacy) === 'on-failure');
  check('policy: legacy disabled maps to never', resolveRestartPolicy({ ...legacy, autoRestart: false }) === 'never');
  check('policy: explicit always overrides legacy disabled', resolveRestartPolicy({ ...legacy, autoRestart: false, restartPolicy: 'always' }) === 'always');
  const body = { id: 'schema', name: 'schema', cwd: '.', executable: process.execPath };
  check('policy API: rejects an unknown policy', !CreateInstanceSchema.safeParse({ ...body, restartPolicy: 'sometimes' }).success);
  const parsed = CreateInstanceSchema.parse(body);
  check('policy API: omitted policy retains legacy default', parsed.restartPolicy === undefined && parsed.autoRestart === true);
  for (const restartPolicy of ['never', 'on-failure', 'always'] as const) {
    check(`policy API: accepts ${restartPolicy}`, CreateInstanceSchema.safeParse({ ...body, restartPolicy }).success);
    for (const mode of ['clean-once', 'crash-once']) {
      const { supervisor, output } = await createHarness(mode, { restartPolicy, autoRestart: false });
      try {
        await supervisor.start();
        const shouldRestart = restartPolicy === 'always' || (restartPolicy === 'on-failure' && mode === 'crash-once');
        if (shouldRestart) {
          const restarted = await waitFor(() => childReadyCount(output()) === 2 && supervisor.getRuntime().status === 'running', 5000);
          check(`${restartPolicy}/${mode}: restarts once`, restarted && supervisor.getRuntime().restartCount === 1, JSON.stringify(supervisor.getRuntime()));
        } else {
          await waitFor(() => isSettled(supervisor), 5000);
          await sleep(RESTART_WINDOW_MS);
          check(`${restartPolicy}/${mode}: no restart`, childReadyCount(output()) === 1 && !supervisor.getRuntime().restartAt, JSON.stringify(supervisor.getRuntime()));
          check(`${restartPolicy}/${mode}: explains why`, supervisor.getRuntime().restartReason === (restartPolicy === 'never' ? 'disabled' : 'clean-exit'));
        }
      } finally {
        await supervisor.dispose();
      }
    }
  }
};

const checkPendingRecovery = async (action: 'stop' | 'dispose' | 'start' | 'restart') => {
  const { supervisor, output } = await createHarness('clean-once', { restartPolicy: 'always', restartDelayMs: 1200 });
  try {
    await supervisor.start();
    const pending = await waitFor(() => !!supervisor.getRuntime().restartAt, 5000);
    if (!check(`pending recovery/${action}: clean exit is scheduled`, pending && supervisor.getRuntime().exitCode === 0)) return;
    if (action === 'stop') supervisor.stop();
    else if (action === 'dispose') await supervisor.dispose();
    else if (action === 'start') await supervisor.start();
    else await supervisor.restart();
    if (action === 'start' || action === 'restart') {
      check(`pending recovery/${action}: replacement child is ready`, await waitFor(() => childReadyCount(output()) === 2, 5000));
    }
    await sleep(1600);
    const runtime = supervisor.getRuntime();
    const manualStart = action === 'start' || action === 'restart';
    check(`pending recovery/${action}: no stale timer or duplicate spawn`, childReadyCount(output()) === (manualStart ? 2 : 1) && !runtime.restartAt && runtime.restartCount === 0, JSON.stringify(runtime));
    check(`pending recovery/${action}: expected state`, runtime.status === (manualStart ? 'running' : 'stopped') && runtime.desiredState === (manualStart ? 'running' : 'stopped'));
  } finally {
    await supervisor.dispose();
  }
};

const checkRecoveryLimit = async () => {
  const { supervisor, output } = await createHarness('clean', { restartPolicy: 'always', restartDelayMs: 40 });
  const delays: number[] = [];
  let lastAttempt = 0;
  supervisor.onStatus((runtime) => {
    if (runtime.restartAt && (runtime.restartCount ?? 0) > lastAttempt) {
      lastAttempt = runtime.restartCount!;
      delays.push(new Date(runtime.restartAt).getTime() - Date.now());
    }
  });
  try {
    await supervisor.start();
    const paused = await waitFor(() => supervisor.getRuntime().restartReason === 'retry-limit', 30000);
    if (!check('recovery limit: pauses after 5 retries on exit 0', paused && childReadyCount(output()) === 6 && supervisor.getRuntime().restartCount === 5 && !supervisor.getRuntime().restartAt, JSON.stringify(supervisor.getRuntime()))) return;
    check('recovery limit: exponential backoff', delays.length === 5 && delays.every((delay, i) => Math.abs(delay - 40 * 2 ** i) < 30), JSON.stringify(delays));
    await sleep(RESTART_WINDOW_MS);
    check('recovery limit: remains paused', childReadyCount(output()) === 6);
    supervisor.stop();
    check('recovery limit: Stop clears desired running state', supervisor.getRuntime().desiredState === 'stopped');
    await supervisor.start();
    check('recovery limit: manual Start clears the breaker', supervisor.getRuntime().restartCount === 0 && !supervisor.getRuntime().restartReason);
  } finally {
    await supervisor.dispose();
  }
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

// A configured stopCommand replaces the signal: sent line by line (leading
// blank lines dropped, a later blank line sent as a bare Enter), the child
// shuts down on its own — printing while it does, which is
// the only way Windows exercises output during `stopping` — and no force-kill
// follows.
const checkStopCommand = async () => {
  const { supervisor, statuses, output, instanceLog } = await createHarness('stop-command', {
    stopCommand: '\n  \nsave_profiles\n  \nquit',
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
  check(
    'stopCommand: lines sent in order; leading blanks dropped, a later blank sent as Enter',
    JSON.stringify(commands) === JSON.stringify(['save_profiles', '', 'quit']),
    JSON.stringify(commands)
  );
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

// rwr_server answers `quit` with "Exit requested" and exits only on the next
// Enter: `quit` + an empty line must stop it without a force-kill, the Enter
// arriving after the prompt.
const checkStopCommandEnter = async () => {
  const { supervisor, statuses, output, instanceLog } = await createHarness('exit-requested', {
    stopCommand: 'quit\n',
    stopTimeoutMs: 10_000
  });
  await supervisor.start();
  const ready = await waitFor(() => output().includes('child ready'), 5000);
  if (!check('stopCommand + Enter: child started', ready, JSON.stringify(output()))) return;

  statuses.length = 0;
  supervisor.stop();
  await waitFor(() => isSettled(supervisor), 8000);
  const text = output();
  const runtime = supervisor.getRuntime();
  check('stopCommand + Enter: sent `quit`, then a bare Enter', JSON.stringify(commandsRead(text)) === JSON.stringify(['quit', '']), JSON.stringify(commandsRead(text)));
  check(
    'stopCommand + Enter: the Enter came well after "Exit requested", not buffered with `quit`',
    text.includes('Exit requested') && !text.includes('early line ignored'),
    JSON.stringify(text.slice(-300))
  );
  check('stopCommand + Enter: ends in stopped', runtime.status === 'stopped', `status=${runtime.status}`);
  check(
    'stopCommand + Enter: never reported running/crashed after the request',
    statuses.every((status) => status === 'stopping' || status === 'stopped'),
    statuses.join(' → ')
  );
  check('stopCommand + Enter: no force-kill', !instanceLog().includes('force-killing'), instanceLog());
};

// A stopCommand of only blank lines is no stop command: the platform default
// (SIGHUP; taskkill on Windows) applies.
const checkBlankStopCommand = async () => {
  const { supervisor, output, instanceLog } = await createHarness('blank-stop', { stopCommand: '  \n\t\n ', stopTimeoutMs: 10_000 });
  await supervisor.start();
  const ready = await waitFor(() => output().includes('child ready'), 5000);
  if (!check('blank stopCommand: child started', ready, JSON.stringify(output()))) return;
  supervisor.stop();
  await waitFor(() => isSettled(supervisor), 8000);
  const logged = await waitFor(() => instanceLog().includes('[squash] stopping:'), 2000);
  check(
    'blank stopCommand: treated as unset',
    logged && instanceLog().includes(`stopping: ${isWindows ? 'taskkill' : 'SIGHUP'}`) && !instanceLog().includes('sending stop command'),
    instanceLog()
  );
  check('blank stopCommand: ends in stopped', supervisor.getRuntime().status === 'stopped', `status=${supervisor.getRuntime().status}`);
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

const childReadyCount = (output: string) => output.split('child ready').length - 1;
// Windows reports `running` twice per start (the PID is filled in with the
// first output), so compare sequences with repeats collapsed.
const collapse = (statuses: readonly InstanceStatus[]) => statuses.filter((status, i) => status !== statuses[i - 1]).join(' → ');

// Whether the given processes were alive when the old run was reported
// `stopped` — onExit sends that before restart() spawns the replacement, so a
// PID recycled by the new process can't blur the answer.
const aliveAtStop = (supervisor: InstanceSupervisor, pids: readonly number[]) => {
  let result: boolean[] | undefined;
  const off = supervisor.onStatus((runtime) => {
    if (runtime.status === 'stopped' && result === undefined) {
      result = pids.map(isAlive);
      off();
    }
  });
  return () => result;
};

// restart() must not spawn the new process until the old one has exited: the
// old one here takes ~200ms to shut down after its stop command.
const checkRestartWaits = async () => {
  const { supervisor, statuses, output } = await createHarness('stop-command', { stopCommand: 'quit', stopTimeoutMs: 10_000 });
  await supervisor.start();
  const ready = await waitFor(() => output().includes('child ready') && (supervisor.getRuntime().pid ?? 0) > 0, 5000);
  if (!check('restart: child started', ready, JSON.stringify(output()))) return;
  const oldPid = supervisor.getRuntime().pid!;

  statuses.length = 0;
  const atStop = aliveAtStop(supervisor, [oldPid]);
  await supervisor.restart();
  check('restart: old process had exited before the new one started', atStop()?.[0] === false, `old pid ${oldPid} alive at stop=${atStop()?.[0]}`);
  // restart() resolves once the new process is spawned, before it prints.
  await waitFor(() => childReadyCount(output()) === 2, 5000);
  const text = output();
  check(
    'restart: old shutdown output precedes the new start',
    text.indexOf('shutting down 1') !== -1 && text.indexOf('shutting down 1') < text.lastIndexOf('child ready'),
    JSON.stringify(text.slice(-300))
  );
  check('restart: went through stopping → stopped → running', collapse(statuses) === 'stopping → stopped → running', statuses.join(' → '));
  const runtime = supervisor.getRuntime();
  check('restart: new process is running', runtime.status === 'running', `status=${runtime.status} pid=${runtime.pid}`);

  // Two restarts at once (two tabs) are one restart, not a start() race.
  const results = await Promise.allSettled([supervisor.restart(), supervisor.restart()]);
  await waitFor(() => childReadyCount(output()) === 3, 5000);
  await sleep(RESTART_WINDOW_MS);
  check(
    'restart: concurrent restarts join into one',
    results.every((result) => result.status === 'fulfilled') && childReadyCount(output()) === 3,
    `${results.map((result) => result.status).join(',')} starts=${childReadyCount(output())}`
  );

  supervisor.stop();
  await waitFor(() => isSettled(supervisor), 8000);
};

// restart() while a stop is under way waits it out (here: the stop command is
// ignored, so until the force-kill) — the old process must be gone, grandchild
// included, before the new one starts.
const checkRestartWhileStopping = async () => {
  const { supervisor, output, instanceLog } = await createHarness('stubborn', { stopCommand: 'quit', stopTimeoutMs: STOP_TIMEOUT_MS });
  await supervisor.start();
  const ready = await waitFor(() => /grandchild \d+/.test(output()) && (supervisor.getRuntime().pid ?? 0) > 0, 5000);
  if (!check('restart while stopping: child and grandchild started', ready, JSON.stringify(output()))) return;
  const oldPid = supervisor.getRuntime().pid!;
  const grandchild = Number(/grandchild (\d+)/.exec(output())![1]);
  strays.add(grandchild);

  const stopAt = Date.now();
  supervisor.stop();
  const ignored = await waitFor(() => output().includes('got "quit"'), 3000);
  if (!check('restart while stopping: child ignored the stop command', ignored && supervisor.getRuntime().status === 'stopping')) return;

  const atStop = aliveAtStop(supervisor, [oldPid, grandchild]);
  let restartError = '';
  try {
    await supervisor.restart();
  } catch (err) {
    restartError = err instanceof Error ? err.message : String(err);
  }
  const elapsed = Date.now() - stopAt;
  check('restart while stopping: accepted', restartError === '', restartError);
  check('restart while stopping: waited for the stop to finish', elapsed >= STOP_TIMEOUT_MS - 100, `${elapsed}ms`);
  // The old child must be gone before the new start; the SIGKILLed
  // grandchild may still await reaping at that instant.
  const [childAtStop, grandchildAtStop] = atStop() ?? [true, true];
  const grandchildGone = !grandchildAtStop || (await waitFor(() => !isAlive(grandchild), 3000));
  check(
    'restart while stopping: old process gone before the new start, grandchild killed',
    !childAtStop && grandchildGone,
    `child alive at stop=${childAtStop} grandchild alive=${isAlive(grandchild)}`
  );
  if (!isAlive(grandchild)) strays.delete(grandchild);
  // The pending stop was joined, not restarted: one command, one stop.
  const quits = commandsRead(output()).filter((command) => command === 'quit').length;
  const stopLines = instanceLog().split('\n').filter((line) => line.includes('[squash] stopping:')).length;
  check('restart while stopping: joined the pending stop', quits === 1 && stopLines === 1, `quits=${quits} stopLines=${stopLines}`);
  const logged = await waitFor(() => instanceLog().includes('force-killing'), 2000);
  check('restart while stopping: the stop was force-killed on timeout', logged, instanceLog());
  const runtime = supervisor.getRuntime();
  check('restart while stopping: new process is running', runtime.status === 'running' && runtime.pid !== oldPid, `status=${runtime.status} pid=${runtime.pid}`);

  if (runtime.status === 'running') {
    supervisor.stop();
    supervisor.stop({ force: true });
    await waitFor(() => isSettled(supervisor), 5000);
  }
};

// A Stop (even a plain one) or dispose() while restart() waits for the old
// process means "stop": the restart must fail and start nothing.
const checkRestartCancelled = async (by: 'stop' | 'force' | 'dispose') => {
  const label = `restart cancelled by ${by}`;
  const { supervisor, output } = await createHarness('stubborn', { restartPolicy: 'always', stopCommand: 'quit', stopTimeoutMs: STOP_TIMEOUT_MS });
  await supervisor.start();
  const ready = await waitFor(() => /grandchild \d+/.test(output()) && (supervisor.getRuntime().pid ?? 0) > 0, 5000);
  if (!check(`${label}: child started`, ready, JSON.stringify(output()))) return;
  strays.add(Number(/grandchild (\d+)/.exec(output())![1]));

  let restartError: string | undefined;
  const restarting = supervisor.restart().then(
    () => {
      restartError = '';
    },
    (err: unknown) => {
      restartError = err instanceof Error ? err.message : String(err);
    }
  );
  const waiting = await waitFor(() => output().includes('got "quit"'), 3000);
  if (!check(`${label}: restart is waiting for the old process`, waiting && supervisor.getRuntime().status === 'stopping', supervisor.getRuntime().status)) return;

  if (by === 'stop') {
    supervisor.stop();
  } else if (by === 'force') {
    supervisor.stop({ force: true });
  } else {
    void supervisor.dispose();
  }
  await restarting;
  await sleep(RESTART_WINDOW_MS);

  const runtime = supervisor.getRuntime();
  check(`${label}: restart failed`, restartError !== undefined && restartError !== '', restartError === '' ? 'restart resolved' : String(restartError));
  check(`${label}: ends in stopped`, runtime.status === 'stopped', `status=${runtime.status}`);
  check(`${label}: no new process was started`, childReadyCount(output()) === 1, JSON.stringify(output()));
};

// Every supervisor a scenario created, so that one which failed half-way does
// not keep a child (or the PTY's handles) alive past the file. The strays go
// first: a scenario that failed may have left a child whose graceful stop
// would outlast this hook (stopTimeoutMs up to 60s) — and a hook that times
// out runs nothing after the await it timed out in.
afterAll(async () => {
  closing = true;
  for (const supervisor of supervisors) {
    if (!isSettled(supervisor)) {
      try {
        supervisor.stop({ force: true });
      } catch {
        // Not stoppable from its state; dispose() below handles it.
      }
    }
  }
  killStrays();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...supervisors].map((supervisor) => supervisor.dispose())),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 10_000);
    })
  ]);
  clearTimeout(timer);
  killStrays();
}, 30_000);

type Declared = string | { readonly label: string; readonly skip: boolean };

// Runs `run` once (beforeAll) and turns each declared label into a test of
// what it recorded: a label never recorded fails as "not reached" (the smoke
// returned early after a failed check and never ran the rest). `skip`: not
// checked on this platform — the scenario does not record it, and recording
// it anyway, or a label not declared at all, fails the scenario.
const scenario = (name: string, labels: readonly Declared[], run: () => Promise<void>, timeoutMs = 60_000) => {
  describe(name, () => {
    const results: CheckResult[] = [];
    const declared = labels.map((entry) => (typeof entry === 'string' ? { label: entry, skip: false } : entry));
    for (const { label, skip } of declared) {
      if (recorders.has(label)) throw new Error(`label "${label}" is declared twice`);
      recorders.set(label, { results, skip });
    }
    beforeAll(async () => {
      try {
        await run();
      } finally {
        // Forget PIDs that are gone right after each scenario, while a
        // recycled PID is least likely.
        for (const pid of strays) {
          if (!isAlive(pid)) strays.delete(pid);
        }
      }
    }, timeoutMs);
    for (const { label, skip } of declared) {
      it.skipIf(skip)(label, () => {
        const result = results.find((entry) => entry.label === label);
        expect(result, 'not reached: an earlier check in this scenario failed and ended it').toBeDefined();
        expect(result!.ok, result!.detail || 'failed').toBe(true);
      });
    }
  });
};

scenario('user stop', [
  'stop: child started',
  'output updates lastOutputAt',
  // kill() is `taskkill /T /F` on Windows: no signal, so no shutdown output.
  { label: 'stop: child printed while stopping', skip: isWindows },
  'stop: ends in stopped',
  'stop: never reported running/crashed after the request',
  'stop: reported stopping first',
  'stop: no auto-restart'
], () => checkUserStop('stop'));

scenario('dispose', [
  'dispose: child started',
  { label: 'dispose: child printed while stopping', skip: isWindows },
  'dispose: ends in stopped',
  'dispose: never reported running/crashed after the request',
  'dispose: reported stopping first',
  'dispose: no auto-restart',
  'dispose: resolves once the process has exited',
  'dispose: a disposed supervisor refuses to start'
], () => checkUserStop('dispose'));

scenario('crash', ['crash: reported crashed', 'crash: auto-restarted'], checkCrashRestarts);

scenario('clean exit', ['clean exit: ends in stopped', 'clean exit: no auto-restart'], checkCleanExit);

scenario('restart policies', [
  'policy: legacy enabled maps to on-failure',
  'policy: legacy disabled maps to never',
  'policy: explicit always overrides legacy disabled',
  'policy API: rejects an unknown policy',
  'policy API: omitted policy retains legacy default',
  ...(['never', 'on-failure', 'always'] as const).flatMap((restartPolicy) => [
    `policy API: accepts ${restartPolicy}`,
    ...['clean-once', 'crash-once'].flatMap((mode) =>
      restartPolicy === 'always' || (restartPolicy === 'on-failure' && mode === 'crash-once')
        ? [`${restartPolicy}/${mode}: restarts once`]
        : [`${restartPolicy}/${mode}: no restart`, `${restartPolicy}/${mode}: explains why`]
    )
  ])
], checkRestartPolicies, 120_000);

for (const action of ['stop', 'dispose', 'start', 'restart'] as const) {
  scenario(`pending recovery/${action}`, [
    `pending recovery/${action}: clean exit is scheduled`,
    ...(action === 'start' || action === 'restart' ? [`pending recovery/${action}: replacement child is ready`] : []),
    `pending recovery/${action}: no stale timer or duplicate spawn`,
    `pending recovery/${action}: expected state`
  ], () => checkPendingRecovery(action));
}

scenario('recovery limit', [
  'recovery limit: pauses after 5 retries on exit 0',
  'recovery limit: exponential backoff',
  'recovery limit: remains paused',
  'recovery limit: Stop clears desired running state',
  'recovery limit: manual Start clears the breaker'
], checkRecoveryLimit);

scenario('resize', [
  'resize: spawns at the 120x40 default',
  'resize: running PTY follows resize()',
  'resize: restart() keeps the last size',
  'resize: while stopped does not throw',
  'resize: next start() uses the size set while stopped'
], checkResize);

scenario('sendCommand', ['sendCommand: child started', 'sendCommand: each command arrives as its own line, in order'], checkSendCommand);

scenario('stopCommand', [
  'stopCommand: child started',
  'stopCommand: lines sent in order; leading blanks dropped, a later blank sent as Enter',
  'stopCommand: child printed while stopping',
  'stopCommand: no signal sent',
  'stopCommand: ends in stopped',
  'stopCommand: never reported running/crashed after the request',
  'stopCommand: no force-kill'
], checkStopCommand);

scenario('stopCommand + Enter', [
  'stopCommand + Enter: child started',
  'stopCommand + Enter: sent `quit`, then a bare Enter',
  'stopCommand + Enter: the Enter came well after "Exit requested", not buffered with `quit`',
  'stopCommand + Enter: ends in stopped',
  'stopCommand + Enter: never reported running/crashed after the request',
  'stopCommand + Enter: no force-kill'
], checkStopCommandEnter);

scenario('blank stopCommand', [
  'blank stopCommand: child started',
  'blank stopCommand: treated as unset',
  'blank stopCommand: ends in stopped'
], checkBlankStopCommand);

for (const via of ['signal', 'command'] as const) {
  const label = `stop timeout (${via})`;
  // No signals on Windows: without a stopCommand, stop is an immediate taskkill.
  const skip = via === 'signal' && isWindows;
  scenario(label, [
    `${label}: child and grandchild started`,
    `${label}: child got the graceful stop and ignored it; grandchild alive`,
    `${label}: ends in stopped`,
    `${label}: waited for stopTimeoutMs first`,
    `${label}: never reported running/crashed after the request`,
    `${label}: no auto-restart`,
    `${label}: instance log records the force-kill`,
    `${label}: child and grandchild are gone`
  ].map((entry) => ({ label: entry, skip })), () => (skip ? Promise.resolve() : checkStopTimeout(via)));
}

scenario('force stop', [
  'force stop: child and grandchild started',
  'force stop: still stopping after the stop command',
  'force stop: a plain Stop while stopping changes nothing',
  'force stop: grandchild alive before the force stop',
  'force stop: accepted while stopping',
  'force stop: ends in stopped at once',
  'force stop: instance log records it',
  'force stop: child and grandchild are gone'
], checkForceStop);

scenario('restart', [
  'restart: child started',
  'restart: old process had exited before the new one started',
  'restart: old shutdown output precedes the new start',
  'restart: went through stopping → stopped → running',
  'restart: new process is running',
  'restart: concurrent restarts join into one'
], checkRestartWaits);

scenario('restart while stopping', [
  'restart while stopping: child and grandchild started',
  'restart while stopping: child ignored the stop command',
  'restart while stopping: accepted',
  'restart while stopping: waited for the stop to finish',
  'restart while stopping: old process gone before the new start, grandchild killed',
  'restart while stopping: joined the pending stop',
  'restart while stopping: the stop was force-killed on timeout',
  'restart while stopping: new process is running'
], checkRestartWhileStopping);

for (const by of ['stop', 'force', 'dispose'] as const) {
  const label = `restart cancelled by ${by}`;
  scenario(label, [
    `${label}: child started`,
    `${label}: restart is waiting for the old process`,
    `${label}: restart failed`,
    `${label}: ends in stopped`,
    `${label}: no new process was started`
  ], () => checkRestartCancelled(by));
}

// Each scenario has its own timeout against a hang; this keeps the smoke's
// limit on the run as a whole. A test, not a check in the afterAll above: a
// hook that throws stops the hooks after it, the temp dir's removal included.
it(`the scenarios finish within ${TOTAL_LIMIT_MS / 1000} s`, () => {
  expect(Date.now() - startedAt).toBeLessThan(TOTAL_LIMIT_MS);
});
