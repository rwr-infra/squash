import { createInstanceLogWriter, toInstanceLogFile } from '../log/log-writer.js';
import { createOutputParser } from '../log/output-parser.js';
import { createPtyProcess } from '../pty/pty-process-adapter.js';
import type { PtyProcess } from '../pty/pty-types.js';
import { assertInstanceState } from './instance-errors.js';
import type { InstanceConfig, InstanceRuntime, InstanceStatus, InstanceSupervisor } from './instance-types.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_TERM_NAME = 'xterm-256color';

const now = () => new Date().toISOString();

const createRuntime = (id: string, status: InstanceStatus): InstanceRuntime => ({
  id,
  status,
  viewers: 0
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
  let runtime = createRuntime(config.id, 'stopped');
  let processRef: PtyProcess | undefined;
  const dataListeners = new Set<(chunk: string) => void>();

  const bindProcessEvents = (ptyProcess: PtyProcess) => {
    ptyProcess.onData(async (chunk) => {
      runtime = markRuntime(runtime, {
        status: 'running',
        lastOutputAt: now()
      });

      const lines = parser.push(chunk);
      await logWriter.writeLines(lines);

      for (const listener of dataListeners) {
        listener(chunk);
      }
    });

    ptyProcess.onExit(async ({ exitCode, signal }) => {
      const pending = parser.flush();
      await logWriter.writeLines(pending);
      runtime = markRuntime(runtime, {
        status: runtime.status === 'stopping' ? 'stopped' : 'crashed',
        stoppedAt: now(),
        exitCode,
        exitSignal: signal
      });
      processRef = undefined;
    });
  };

  const start = async () => {
    assertInstanceState(canStart(runtime.status), `Cannot start instance from state ${runtime.status}`);
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

    return runtime;
  };

  const stopProcess = () => {
    assertInstanceState(canStop(runtime.status), `Cannot stop instance from state ${runtime.status}`);
    runtime = markRuntime(runtime, { status: 'stopping' });
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
      if (canStop(runtime.status)) {
        stopProcess();
      }

      runtime = markRuntime(runtime, {
        status: 'stopped',
        pid: undefined
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
    resize(cols, rows) {
      assertInstanceState(runtime.status === 'running', 'Cannot resize unless instance is running');
      processRef?.resize(cols, rows);
    },
    getRuntime() {
      return runtime;
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    }
  };
};
