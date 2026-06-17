import { createInstanceLogWriter, toInstanceLogFile } from '../log/log-writer.js';
import { createOutputParser } from '../log/output-parser.js';
import { createPtyProcess } from '../pty/pty-process-adapter.js';
import { detectWerFaultFor } from '../pty/windows-werfault.js';
import type { PtyProcess } from '../pty/pty-types.js';
import { assertInstanceState } from './instance-errors.js';
import type {
  CaptureCommandOptions,
  InstanceConfig,
  InstanceRuntime,
  InstanceStatus,
  InstanceSupervisor
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
const canStop = (status: InstanceStatus) => status === 'starting' || status === 'running';

export const createInstanceSupervisor = async (config: InstanceConfig): Promise<InstanceSupervisor> => {
  const parser = createOutputParser();
  const logWriter = await createInstanceLogWriter(toInstanceLogFile(config.logDir, config.id));
  const restartDelayMs = config.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const watchdogEnabled = isWindows && config.autoRestart === true;

  let runtime = createRuntime(config.id, 'stopped');
  let processRef: PtyProcess | undefined;
  let outputBuffer = '';
  const dataListeners = new Set<(chunk: string) => void>();
  const statusListeners = new Set<(runtime: InstanceRuntime) => void>();

  const notifyStatus = () => {
    for (const listener of statusListeners) {
      listener(runtime);
    }
  };

  let restartAttempts = 0;
  let restartTimer: NodeJS.Timeout | undefined;
  let resetTimer: NodeJS.Timeout | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;

  const log = (line: string) => logWriter.writeLines([`[squash] ${line}`]);

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

  const startWatchdog = () => {
    if (!watchdogEnabled) {
      return;
    }
    stopWatchdog();
    watchdogTimer = setInterval(async () => {
      const pid = processRef?.pid;
      if (pid === undefined || runtime.status !== 'running') {
        return;
      }
      const hung = await detectWerFaultFor(pid);
      if (hung && processRef && runtime.status === 'running') {
        await log('WerFault.exe detected — instance crashed and is hanging; force-killing process tree');
        // Force-kill triggers onExit → crashed → scheduleRestart.
        processRef.kill();
      }
    }, WATCHDOG_INTERVAL_MS);
  };

  const scheduleRestart = () => {
    clearTimer(restartTimer);
    if (!config.autoRestart) {
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

  const bindProcessEvents = (ptyProcess: PtyProcess) => {
    ptyProcess.onData(async (chunk) => {
      runtime = markRuntime(runtime, {
        status: 'running',
        lastOutputAt: now()
      });

      outputBuffer = (outputBuffer + chunk).slice(-OUTPUT_BUFFER_LIMIT);

      const lines = parser.push(chunk);
      await logWriter.writeLines(lines);

      for (const listener of dataListeners) {
        listener(chunk);
      }
    });

    ptyProcess.onExit(async ({ exitCode, signal }) => {
      stopWatchdog();
      clearTimer(resetTimer);
      resetTimer = undefined;

      const pending = parser.flush();
      await logWriter.writeLines(pending);

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

      if (!userStopped && !cleanExit) {
        scheduleRestart();
      }
    });
  };

  const start = async () => {
    assertInstanceState(canStart(runtime.status), `Cannot start instance from state ${runtime.status}`);
    outputBuffer = '';
    runtime = markRuntime(runtime, {
      status: 'starting',
      startedAt: now(),
      stoppedAt: undefined,
      exitCode: undefined,
      exitSignal: undefined
    });

    processRef = createPtyProcess({
      command: config.executable,
      args: config.args,
      cwd: config.cwd,
      env: { ...process.env, ...config.env, PATH: process.env.PATH, HOME: process.env.HOME },
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      name: DEFAULT_TERM_NAME
    });

    bindProcessEvents(processRef);
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

  const stopProcess = () => {
    assertInstanceState(canStop(runtime.status), `Cannot stop instance from state ${runtime.status}`);
    clearRestartState();
    restartAttempts = 0;
    stopWatchdog();
    runtime = markRuntime(runtime, { status: 'stopping', restartCount: 0 });
    notifyStatus();
    processRef?.kill();
  };

  return {
    id: config.id,
    async start() {
      return start();
    },
    stop() {
      stopProcess();
    },
    async restart() {
      clearRestartState();
      restartAttempts = 0;
      stopWatchdog();

      if (canStop(runtime.status)) {
        runtime = markRuntime(runtime, { status: 'stopping' });
        processRef?.kill();
      }

      runtime = markRuntime(runtime, {
        status: 'stopped',
        pid: undefined,
        restartCount: 0
      });

      return start();
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
      assertInstanceState(runtime.status === 'running', 'Cannot resize unless instance is running');
      processRef?.resize(cols, rows);
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
    dispose() {
      clearRestartState();
      restartAttempts = 0;
      stopWatchdog();
      if (processRef && (runtime.status === 'running' || runtime.status === 'starting')) {
        runtime = markRuntime(runtime, { status: 'stopping' });
        processRef.kill();
      }
    }
  };
};
