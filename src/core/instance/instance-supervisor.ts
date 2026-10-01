import { createInstanceLogWriter, toInstanceLogFile } from '../log/log-writer.js';
import { createOutputParser } from '../log/output-parser.js';
import { createPtyProcess } from '../pty/pty-process-adapter.js';
import { readCrashDumpMtime } from '../pty/rwr-crashdump.js';
import type { PtyProcess } from '../pty/pty-types.js';
import { assertInstanceState } from './instance-errors.js';
import type {
  CaptureCommandOptions,
  InstanceConfig,
  InstanceRuntime,
  InstanceStatus,
  InstanceSupervisor,
  RestartPolicy,
  StopOptions
} from './instance-types.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_TERM_NAME = 'xterm-256color';

const DEFAULT_RESTART_DELAY_MS = 3000;
const MAX_RESTART_ATTEMPTS = 5;
const MAX_RESTART_DELAY_MS = 60_000;
// Successful uptime past this window means the crash loop is over → reset counter.
const RESET_AFTER_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 5000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const MIN_STOP_TIMEOUT_MS = 1000;
const MAX_STOP_TIMEOUT_MS = 600_000;
// How much longer than stopTimeoutMs restart() waits for the old process
// before giving up (a force-kill that never produced an exit).
const RESTART_EXIT_GRACE_MS = 5000;
// Stop command lines go out this far apart, so a server can print its prompt
// ("Exit requested") before the next line — the Enter it waits for — arrives.
const STOP_COMMAND_LINE_GAP_MS = 1000;
const MAX_CAPTURE_MS = 10_000;
// Recent raw output (incl. ANSI) replayed to terminals that connect after the
// process has already printed — e.g. a startup burst that finished before the
// WebSocket attached.
const OUTPUT_BUFFER_LIMIT = 64 * 1024;

const isWindows = process.platform === 'win32';

const now = () => new Date().toISOString();

const createRuntime = (id: string, status: InstanceStatus): InstanceRuntime => ({
  id,
  status,
  viewers: 0,
  desiredState: 'stopped',
  restartCount: 0
});

const markRuntime = (runtime: InstanceRuntime, changes: Partial<InstanceRuntime>): InstanceRuntime => ({
  ...runtime,
  ...changes
});

const canStart = (status: InstanceStatus) => status === 'stopped' || status === 'crashed';
// Stop while already `stopping` is a no-op, or a force stop when asked for.
const canStop = (status: InstanceStatus) => status === 'starting' || status === 'running' || status === 'stopping';

// config/instances.json is loaded without schema validation, so a hand-edited
// value that is not an in-range integer / a string counts as unset.
export const resolveStopTimeoutMs = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_STOP_TIMEOUT_MS && value <= MAX_STOP_TIMEOUT_MS
    ? value
    : DEFAULT_STOP_TIMEOUT_MS;

// Explicit policies win; legacy configs keep their original restart behavior.
export const resolveRestartPolicy = (config: InstanceConfig): RestartPolicy =>
  config.restartPolicy === 'never' || config.restartPolicy === 'on-failure' || config.restartPolicy === 'always'
    ? config.restartPolicy
    : config.autoRestart ? 'on-failure' : 'never';
// One command per line. A blank line (after the first command) sends a bare
// Enter: rwr_server, for one, answers `quit` with "Exit requested" and exits
// only on the next Enter. Leading blank lines are dropped; an all-blank value
// counts as unset.
const parseStopCommands = (value: unknown): readonly string[] => {
  if (typeof value !== 'string') return [];
  const lines = value.split(/\r?\n|\r/).map((line) => line.trim());
  const first = lines.findIndex((line) => line.length > 0);
  return first === -1 ? [] : lines.slice(first);
};

export const createInstanceSupervisor = async (config: InstanceConfig): Promise<InstanceSupervisor> => {
  const parser = createOutputParser();
  const logWriter = await createInstanceLogWriter(toInstanceLogFile(config.logDir, config.id));
  const restartDelayMs = typeof config.restartDelayMs === 'number' && Number.isInteger(config.restartDelayMs) && config.restartDelayMs >= 0
    ? config.restartDelayMs
    : DEFAULT_RESTART_DELAY_MS;
  const restartPolicy = resolveRestartPolicy(config);
  const watchdogEnabled = isWindows && restartPolicy !== 'never';
  const stopTimeoutMs = resolveStopTimeoutMs(config.stopTimeoutMs);
  const stopCommands = parseStopCommands(config.stopCommand);

  let runtime = createRuntime(config.id, 'stopped');
  let processRef: PtyProcess | undefined;
  // Settles once processRef's onExit has run (status updated, processRef
  // cleared). Only meaningful while processRef is set — see waitForExit().
  let processExit: Promise<void> = Promise.resolve();
  // Last size a viewer asked for. Every spawn uses it, so a restart (manual or
  // automatic, watched or not) keeps the browser's dimensions.
  let ptySize: { readonly cols: number; readonly rows: number } = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  let outputBuffer = '';
  const dataListeners = new Set<(chunk: string) => void>();
  const statusListeners = new Set<(runtime: InstanceRuntime) => void>();

  const notifyStatus = () => {
    for (const listener of statusListeners) {
      listener(runtime);
    }
  };

  let restartAttempts = 0;
  // Set by dispose(): this supervisor is being discarded (edit/delete/squash
  // shutdown) and must never spawn again.
  let disposed = false;
  let desiredRunning = false;
  // Bumped by every stop()/dispose(): a restart() waiting for the old process
  // to exit must not start a new one if someone asked to stop meanwhile.
  let stopRequests = 0;
  // A restart() in progress; concurrent calls (two tabs, two users) join it
  // instead of racing each other to start().
  let restartInFlight: Promise<InstanceRuntime> | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  // The stop command lines still to be sent.
  let stopLineTimers: NodeJS.Timeout[] = [];
  let restartTimer: NodeJS.Timeout | undefined;
  let resetTimer: NodeJS.Timeout | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  // Wall-clock start of the current run; a crash dump whose mtime is newer than
  // this was written by *this* run's crash (older dumps are stale and ignored).
  let currentRunStartedAtMs = 0;

  // Queued, so lines keep their order and onExit can wait for them: squash may
  // exit right after an instance stops (shutdown), and the line saying why it
  // was force-killed must not be lost. Best-effort: a failed write (log dir
  // removed, disk full) must not become an unhandled rejection either.
  let logQueue: Promise<void> = Promise.resolve();
  const log = (line: string) => {
    logQueue = logQueue.then(() =>
      logWriter.writeLines([`[squash] ${line}`]).catch(() => {
        /* ignore */
      })
    );
    return logQueue;
  };

  const clearTimer = (timer: NodeJS.Timeout | undefined) => {
    if (timer) {
      clearTimeout(timer);
    }
  };

  const stopWatchdog = () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = undefined;
    }
  };

  const dropPendingStopLines = () => {
    stopLineTimers.forEach(clearTimer);
    stopLineTimers = [];
  };

  const clearStopTimers = () => {
    clearTimer(stopTimer);
    stopTimer = undefined;
    dropPendingStopLines();
  };

  const clearRestartState = () => {
    clearTimer(restartTimer);
    clearTimer(resetTimer);
    restartTimer = undefined;
    resetTimer = undefined;
    runtime = markRuntime(runtime, { restartAt: undefined });
  };

  // When rwr_server crashes on Windows its engine writes <cwd>/rwr_crashdump.dmp
  // and pops its own modal "An unhandled exception occurred!" dialog, which hangs
  // the process in a message loop — node-pty never sees an exit, so onExit never
  // fires. A dump file newer than this run's start is the signal that the process
  // has crashed and is now stuck behind that dialog.
  const startWatchdog = () => {
    if (!watchdogEnabled) {
      return;
    }
    stopWatchdog();
    watchdogTimer = setInterval(async () => {
      if (processRef === undefined || runtime.status !== 'running') {
        return;
      }
      const watchedProcess = processRef;
      const watchedStart = currentRunStartedAtMs;
      const dumpMtime = await readCrashDumpMtime(config.cwd);
      const crashed = dumpMtime !== undefined && dumpMtime > watchedStart;
      if (crashed && processRef === watchedProcess && runtime.status === 'running' && desiredRunning) {
        await log('crash detected (fresh rwr_crashdump.dmp) — instance is hanging behind a dialog; force-killing process tree');
        // Force-kill triggers onExit → crashed → scheduleRestart.
        if (processRef === watchedProcess && runtime.status === 'running' && desiredRunning) watchedProcess.kill('force');
      }
    }, WATCHDOG_INTERVAL_MS);
  };

  const scheduleRestart = () => {
    clearTimer(restartTimer);
    if (restartPolicy === 'never' || disposed || !desiredRunning || processRef || !canStart(runtime.status)) {
      return;
    }
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      runtime = markRuntime(runtime, { restartAt: undefined, restartReason: 'retry-limit' });
      notifyStatus();
      void log(`reached max restart attempts (${MAX_RESTART_ATTEMPTS}); auto-restart paused`);
      return;
    }

    const delay = Math.min(restartDelayMs * 2 ** restartAttempts, MAX_RESTART_DELAY_MS);
    restartAttempts += 1;
    runtime = markRuntime(runtime, {
      restartCount: restartAttempts,
      restartAt: new Date(Date.now() + delay).toISOString(),
      restartReason: 'unexpected-exit'
    });
    void log(`scheduling auto-restart #${restartAttempts} in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (disposed || !desiredRunning || processRef || !canStart(runtime.status)) return;
      start().catch((err: unknown) => {
        void log(`auto-restart failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, delay);
    notifyStatus();
  };

  // Returns a promise that settles once this process's onExit has been handled.
  const bindProcessEvents = (ptyProcess: PtyProcess): Promise<void> => {
    // Guard against a stale process: only the process that is still
    // `processRef` may mutate shared runtime state. restart() now waits for the
    // old process's onExit before spawning, so this should never trigger; it
    // stays as a backstop against a late onData/onExit from a replaced process.
    const isCurrent = () => processRef === ptyProcess;
    let resolveExit = () => {};
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    ptyProcess.onData(async (chunk) => {
      if (!isCurrent()) {
        return;
      }
      // On Windows node-pty fills the child PID asynchronously (only after the
      // ConPTY data pipe is ready), so the PID captured in start() is still the
      // placeholder 0 at that point. The first output arrives AFTER the pipe is
      // up, so by now ptyProcess.pid holds the real value — patch it in.
      if (runtime.pid !== ptyProcess.pid) {
        runtime = markRuntime(runtime, { pid: ptyProcess.pid });
        notifyStatus();
      }
      // Output never changes the status: start() already set `running`, and a
      // server logging its shutdown must not flip `stopping` back — onExit would
      // then take a user stop for a crash and auto-restart it.
      runtime = markRuntime(runtime, { lastOutputAt: now() });

      outputBuffer = (outputBuffer + chunk).slice(-OUTPUT_BUFFER_LIMIT);

      const lines = parser.push(chunk);
      try {
        await logWriter.writeLines(lines);
      } catch {
        // Keep relaying output: a failed log write must not become an
        // unhandled rejection that takes squash down.
      }

      for (const listener of dataListeners) {
        listener(chunk);
      }
    });

    ptyProcess.onExit(async ({ exitCode, signal }) => {
      if (!isCurrent()) {
        // A process we already replaced finally exited — ignore it so it can't
        // clobber the new process's status to `crashed` or null out processRef.
        resolveExit();
        return;
      }
      stopWatchdog();
      clearTimer(resetTimer);
      resetTimer = undefined;
      clearStopTimers();

      try {
        await logWriter.writeLines(parser.flush());
      } catch {
        // A failed log write must not keep the status from settling — that
        // would leave the instance `stopping` forever.
      }
      await logQueue;
      // Again: a stop()/dispose() during the await may have armed a new one.
      clearStopTimers();

      const userStopped = !desiredRunning || runtime.status === 'stopping';
      // Exit classification remains independent of recovery: always also
      // recovers clean completion, while on-failure preserves one-shot jobs.
      const cleanExit = exitCode === 0 && !signal;
      runtime = markRuntime(runtime, {
        status: userStopped || cleanExit ? 'stopped' : 'crashed',
        stoppedAt: now(),
        exitCode,
        exitSignal: signal,
        pid: undefined,
        restartAt: undefined,
        restartReason: userStopped ? 'manual-stop' : restartPolicy === 'never' ? 'disabled' : cleanExit && restartPolicy === 'on-failure' ? 'clean-exit' : 'unexpected-exit'
      });
      processRef = undefined;
      notifyStatus();
      resolveExit();

      void log(`process exited: code=${exitCode} signal=${signal ?? 0} uptimeMs=${Date.now() - currentRunStartedAtMs} policy=${restartPolicy} desiredState=${desiredRunning ? 'running' : 'stopped'} reason=${runtime.restartReason}`);
      if (!userStopped && (restartPolicy === 'always' || !cleanExit)) {
        scheduleRestart();
      }
    });

    return exited;
  };

  const waitForExit = () => (processRef ? processExit : Promise.resolve());

  const restart = async () => {
    assertInstanceState(!disposed, 'Instance has been disposed');
    clearRestartState();
    restartAttempts = 0;
    stopWatchdog();

    if (processRef) {
      // The new process starts only after the old one has exited — never both
      // at once (ports, save files). A stop already under way is waited out,
      // timeout and force-kill included.
      const requests = stopRequests;
      if (runtime.status !== 'stopping') {
        beginStop(processRef);
      }
      let giveUp: NodeJS.Timeout | undefined;
      const exited = await Promise.race([
        waitForExit().then(() => true),
        new Promise<boolean>((resolve) => {
          giveUp = setTimeout(() => resolve(false), stopTimeoutMs + RESTART_EXIT_GRACE_MS);
        })
      ]);
      clearTimer(giveUp);
      assertInstanceState(exited, 'Restart failed: the process did not exit; it is still stopping');
      assertInstanceState(stopRequests === requests, 'Restart cancelled: the instance was stopped while restarting');
    } else if (!canStart(runtime.status)) {
      // No live process to wait for: nothing to stop.
      runtime = markRuntime(runtime, { status: 'stopped', stoppedAt: now() });
    }

    runtime = markRuntime(runtime, { restartCount: 0 });
    return start();
  };

  const start = async () => {
    assertInstanceState(!disposed, 'Instance has been disposed');
    assertInstanceState(canStart(runtime.status), `Cannot start instance from state ${runtime.status}`);
    clearTimer(restartTimer);
    restartTimer = undefined;
    desiredRunning = true;
    outputBuffer = '';
    currentRunStartedAtMs = Date.now();
    runtime = markRuntime(runtime, {
      status: 'starting',
      startedAt: now(),
      stoppedAt: undefined,
      exitCode: undefined,
      exitSignal: undefined,
      desiredState: 'running',
      restartAt: undefined,
      restartReason: undefined
    });

    let ptyProcess: PtyProcess;
    try {
      ptyProcess = createPtyProcess({
        command: config.executable,
        args: config.args,
        cwd: config.cwd,
        env: { ...process.env, ...config.env, PATH: process.env.PATH, HOME: process.env.HOME },
        cols: ptySize.cols,
        rows: ptySize.rows,
        name: DEFAULT_TERM_NAME
      });
    } catch (err) {
      // The spawn itself failed (e.g. node-pty couldn't resolve the executable —
      // a Windows relative-path ENOENT). There is now no process, so onExit will
      // never fire and nothing would ever move us out of 'starting' — which in
      // turn wedges stop()/edit. Roll back to a recoverable state. We do NOT
      // scheduleRestart here: a broken config would just loop MAX_RESTART_ATTEMPTS
      // times for nothing; the user should fix the config and retry.
      runtime = markRuntime(runtime, {
        status: 'crashed',
        stoppedAt: now(),
        pid: undefined,
        restartReason: 'spawn-failed'
      });
      notifyStatus();
      throw err;
    }

    processRef = ptyProcess;
    processExit = bindProcessEvents(processRef);
    runtime = markRuntime(runtime, {
      status: 'running',
      pid: processRef.pid
    });
    notifyStatus();

    startWatchdog();

    // Reset the crash-loop counter once the instance has run long enough.
    clearTimer(resetTimer);
    resetTimer = setTimeout(() => {
      resetTimer = undefined;
      if (restartAttempts > 0) {
        restartAttempts = 0;
        runtime = markRuntime(runtime, { restartCount: 0 });
        notifyStatus();
      }
    }, RESET_AFTER_MS);

    return runtime;
  };

  // Ask the live process to exit — its stop command(s), else the platform's
  // graceful kill — and force-kill it if it is still running after
  // stopTimeoutMs. onExit settles the status.
  const beginStop = (ptyProcess: PtyProcess) => {
    runtime = markRuntime(runtime, { status: 'stopping', restartCount: 0 });
    notifyStatus();

    clearStopTimers();
    stopTimer = setTimeout(() => {
      stopTimer = undefined;
      if (processRef !== ptyProcess) {
        return;
      }
      void log(`stop timed out after ${stopTimeoutMs}ms; force-killing`);
      // No more console input for a process that is being killed.
      dropPendingStopLines();
      ptyProcess.kill('force');
    }, stopTimeoutMs);

    if (stopCommands.length > 0) {
      void log(`stopping: sending stop command; force-kill after ${stopTimeoutMs}ms`);
      const [first, ...rest] = stopCommands;
      if (rest.length * STOP_COMMAND_LINE_GAP_MS >= stopTimeoutMs) {
        void log(
          `stop command has ${stopCommands.length} lines sent ${STOP_COMMAND_LINE_GAP_MS}ms apart, but the force-kill comes after ${stopTimeoutMs}ms; raise stopTimeoutMs`
        );
      }
      try {
        ptyProcess.write(`${first}\r`);
        stopLineTimers = rest.map((command, i) =>
          setTimeout(() => {
            if (processRef !== ptyProcess) {
              return;
            }
            try {
              ptyProcess.write(`${command}\r`);
            } catch {
              // On its way out; the stop timer still has the last word.
            }
          }, (i + 1) * STOP_COMMAND_LINE_GAP_MS)
        );
        return;
      } catch (err) {
        void log(`stop command failed (${err instanceof Error ? err.message : String(err)}); killing instead`);
      }
    } else {
      void log(`stopping: ${isWindows ? 'taskkill' : 'SIGHUP'}; force-kill after ${stopTimeoutMs}ms`);
    }
    ptyProcess.kill('graceful');
  };

  const stopProcess = (options: StopOptions = {}) => {
    assertInstanceState(canStop(runtime.status) || desiredRunning || !!restartTimer, `Cannot stop instance from state ${runtime.status}`);
    desiredRunning = false;
    runtime = markRuntime(runtime, { desiredState: 'stopped', restartReason: 'manual-stop' });
    stopRequests += 1;
    clearRestartState();
    restartAttempts = 0;
    stopWatchdog();
    // If there is no live process to kill (e.g. spawn failed leaving status in
    // 'starting'/'running' with processRef === undefined), onExit will never fire
    // and we'd be stuck in 'stopping' forever — unblocking stop()/edit. Flip
    // straight to 'stopped' in that case.
    if (!processRef) {
      clearStopTimers();
      runtime = markRuntime(runtime, { status: 'stopped', stoppedAt: now(), restartCount: 0 });
      notifyStatus();
      return;
    }
    if (runtime.status === 'stopping') {
      if (options.force) {
        void log('force stop requested; force-killing');
        dropPendingStopLines();
        processRef.kill('force');
      }
      return;
    }
    beginStop(processRef);
  };

  return {
    id: config.id,
    async start() {
      assertInstanceState(canStart(runtime.status), `Cannot start instance from state ${runtime.status}`);
      clearRestartState();
      restartAttempts = 0;
      runtime = markRuntime(runtime, { restartCount: 0 });
      return start();
    },
    stop(options) {
      stopProcess(options);
    },
    restart() {
      restartInFlight ??= restart().finally(() => {
        restartInFlight = undefined;
      });
      return restartInFlight;
    },
    sendCommand(command) {
      assertInstanceState(runtime.status === 'running', 'Cannot send command unless instance is running');
      processRef?.write(`${command}\r`);
    },
    sendRawInput(data) {
      assertInstanceState(runtime.status === 'running', 'Cannot send input unless instance is running');
      processRef?.write(data);
    },
    captureCommand(command, opts?: CaptureCommandOptions) {
      assertInstanceState(runtime.status === 'running', 'Cannot send command unless instance is running');
      const appendNewline = opts?.appendNewline ?? true;
      const captureMs = opts?.captureMs;
      const payload = appendNewline ? `${command}\r` : command;

      if (captureMs === undefined || captureMs <= 0) {
        processRef?.write(payload);
        return Promise.resolve('');
      }

      return new Promise<string>((resolve) => {
        let collected = '';
        const listener = (chunk: string) => {
          collected += chunk;
        };
        dataListeners.add(listener);
        processRef?.write(payload);
        setTimeout(() => {
          dataListeners.delete(listener);
          resolve(collected);
        }, Math.min(captureMs, MAX_CAPTURE_MS));
      });
    },
    resize(cols, rows) {
      // Not a state transition: when nothing is running, just remember the size
      // for the next start().
      ptySize = { cols, rows };
      if (runtime.status === 'running') {
        processRef?.resize(cols, rows);
      }
    },
    getRuntime() {
      return runtime;
    },
    getRecentOutput() {
      return outputBuffer;
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    async dispose() {
      disposed = true;
      desiredRunning = false;
      runtime = markRuntime(runtime, { desiredState: 'stopped', restartAt: undefined, restartReason: 'manual-stop', restartCount: 0 });
      stopRequests += 1;
      clearRestartState();
      restartAttempts = 0;
      stopWatchdog();
      // A stop already under way keeps its own timer.
      if (processRef && runtime.status !== 'stopping') {
        beginStop(processRef);
      } else {
        notifyStatus();
      }
      await waitForExit();
      await logQueue;
    }
  };
};
