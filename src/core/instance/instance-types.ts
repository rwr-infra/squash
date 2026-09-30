export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export type InstanceConfig = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly logDir: string;
  readonly autoStart?: boolean;
  readonly autoRestart?: boolean;
  readonly restartDelayMs?: number;
  // Console command(s) that shut the server down gracefully, one per line, each
  // sent followed by Enter (e.g. `quit` for rwr_server). Blank = none: fall back
  // to the platform's graceful kill.
  readonly stopCommand?: string;
  // How long a stop waits for the process to exit before force-killing it.
  readonly stopTimeoutMs?: number;
};

export type InstanceRuntime = {
  readonly id: string;
  readonly status: InstanceStatus;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly lastOutputAt?: string;
  readonly exitCode?: number;
  readonly exitSignal?: number;
  readonly viewers: number;
  readonly restartCount?: number;
};

export type InstanceSupervisor = {
  readonly id: string;
  start: () => Promise<InstanceRuntime>;
  // Starts a graceful stop (see InstanceConfig.stopCommand/stopTimeoutMs); does
  // not wait for the exit. While already `stopping`, only `force` does
  // anything — it kills at once — so a repeated or stale Stop can't cut a
  // graceful shutdown short.
  stop: (options?: StopOptions) => void;
  restart: () => Promise<InstanceRuntime>;
  sendCommand: (command: string) => void;
  sendRawInput: (data: string) => void;
  captureCommand: (command: string, opts?: CaptureCommandOptions) => Promise<string>;
  resize: (cols: number, rows: number) => void;
  getRuntime: () => InstanceRuntime;
  getRecentOutput: () => string;
  onData: (listener: (chunk: string) => void) => () => void;
  onStatus: (listener: (runtime: InstanceRuntime) => void) => () => void;
  // Stops any live process the same way as stop() and never spawns again;
  // resolves once no process is left. Call before discarding a supervisor
  // (delete/edit/shutdown) so a pending auto-restart can't fire.
  dispose: () => Promise<void>;
};

export type StopOptions = {
  readonly force?: boolean;
};

export type CaptureCommandOptions = {
  readonly appendNewline?: boolean;
  readonly captureMs?: number;
};
