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
const MAX_STOP_TIMEOUT_MS = 120_000;
// How much longer than stopTimeoutMs restart() waits for the old process
// before giving up (a force-kill that never produced an exit).
const RESTART_EXIT_GRACE_MS = 5000;
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
const resolveStopTimeoutMs = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_STOP_TIMEOUT_MS && value <= MAX_STOP_TIMEOUT_MS
    ? value
    : DEFAULT_STOP_TIMEOUT_MS;
const parseStopCommands = (value: unknown): readonly string[] =>
  typeof value === 'string'
    ? value.split(/\r?\n|\r/).map((line) => line.trim()).filter((line) => line.length > 0)
    : [];

export const createInstanceSupervisor = async (config: InstanceConfig): Promise<InstanceSupervisor> => {
  const parser = createOutputParser();
  const logWriter = await createInstanceLogWriter(toInstanceLogFile(config.logDir, config.id));
  const restartDelayMs = config.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const watchdogEnabled = isWindows && config.autoRestart === true;
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
  // Bumped by every stop()/dispose(): a restart() waiting for the old process
  // to exit must not start a new one if someone asked to stop meanwhile.
  let stopRequests = 0;
  // A restart() in progress; concurrent calls (two tabs, two users) join it
  // instead of racing each other to start().
  let restartInFlight: Promise<InstanceRuntime> | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let resetTimer: NodeJS.Timeout | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  // Wall-clock start of the current run; a crash dump whose mtime is newer than
  // this was written by *this* run's crash (older dumps are stale and ignored).
  let currentRunStartedAtMs = 0;

  // Best-effort: a failed write (log dir removed, disk full) must not become an
  // unhandled rejection that takes squash down.
  const log = (line: string) =>
    logWriter.writeLines([`[squash] ${line}`]).catch(() => {
      /* ignore */
    });

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

  const clearRestartState = () => {
    clearTimer(restartTimer);
    clearTimer(resetTimer);
    restartTimer = undefined;
    resetTimer = undefined;
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
      const dumpMtime = await readCrashDumpMtime(config.cwd);
      const crashed = dumpMtime !== undefined && dumpMtime > currentRunStartedAtMs;
      if (crashed && processRef && runtime.status === 'running') {
        await log('crash detected (fresh rwr_crashdump.dmp) — instance is hanging behind a dialog; force-killing process tree');
        // Force-kill triggers onExit → crashed → scheduleRestart.
        processRef.kill('force');
      }
    }, WATCHDOG_INTERVAL_MS);
  };

  const scheduleRestart = () => {
    clearTimer(restartTimer);
    if (!config.autoRestart || disposed) {
      return;
    }
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      void log(`reached max restart attempts (${MAX_RESTART_ATTEMPTS}); leaving instance crashed`);
      return;
    }

    const delay = Math.min(restartDelayMs * 2 ** restartAttempts, MAX_RESTART_DELAY_MS);
    restartAttempts += 1;
    runtime = markRuntime(runtime, { restartCount: restartAttempts });
    void log(`scheduling auto-restart #${restartAttempts} in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      start().catch((err: unknown) => {
        void log(`auto-restart failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, delay);
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
      clearTimer(stopTimer);
      stopTimer = undefined;

      try {
        await logWriter.writeLines(parser.flush());
      } catch {
        // A failed log write must not keep the status from settling — that
        // would leave the instance `stopping` forever.
      }
      // Again: a stop()/dispose() during the await may have armed a new one.
      clearTimer(stopTimer);
      stopTimer = undefined;

      const userStopped = runtime.status === 'stopping';
      // A clean exit (code 0, no signal) is a normal completion — e.g. a one-shot
      // command like steamcmd that finishes — not a crash, so don't auto-restart.
      const cleanExit = exitCode === 0 && !signal;
      runtime = markRuntime(runtime, {
        status: userStopped || cleanExit ? 'stopped' : 'crashed',
        stoppedAt: now(),
        exitCode,
        exitSignal: signal
      });
      processRef = undefined;
      notifyStatus();
      resolveExit();

      if (!userStopped && !cleanExit) {
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
    outputBuffer = '';
    currentRunStartedAtMs = Date.now();
    runtime = markRuntime(runtime, {
      status: 'starting',
      startedAt: now(),
      stoppedAt: undefined,
      exitCode: undefined,
      exitSignal: undefined
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
        stoppedAt: now()
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

    clearTimer(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = undefined;
      if (processRef !== ptyProcess) {
        return;
      }
      void log(`stop timed out after ${stopTimeoutMs}ms; force-killing`);
      ptyProcess.kill('force');
    }, stopTimeoutMs);

    if (stopCommands.length > 0) {
      void log(`stopping: sending stop command; force-kill after ${stopTimeoutMs}ms`);
      try {
        for (const command of stopCommands) {
          ptyProcess.write(`${command}\r`);
        }
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
    assertInstanceState(canStop(runtime.status), `Cannot stop instance from state ${runtime.status}`);
    stopRequests += 1;
    clearRestartState();
    restartAttempts = 0;
    stopWatchdog();
    // If there is no live process to kill (e.g. spawn failed leaving status in
    // 'starting'/'running' with processRef === undefined), onExit will never fire
    // and we'd be stuck in 'stopping' forever — unblocking stop()/edit. Flip
    // straight to 'stopped' in that case.
    if (!processRef) {
      clearTimer(stopTimer);
      stopTimer = undefined;
      runtime = markRuntime(runtime, { status: 'stopped', stoppedAt: now(), restartCount: 0 });
      notifyStatus();
      return;
    }
    if (runtime.status === 'stopping') {
      if (options.force) {
        void log('force stop requested; force-killing');
        processRef.kill('force');
      }
      return;
    }
    beginStop(processRef);
  };

  return {
    id: config.id,
    async start() {
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
      stopRequests += 1;
      clearRestartState();
      restartAttempts = 0;
      stopWatchdog();
      // A stop already under way keeps its own timer.
      if (processRef && runtime.status !== 'stopping') {
        beginStop(processRef);
      }
      await waitForExit();
    }
  };
};
