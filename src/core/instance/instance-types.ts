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
};

export type InstanceSupervisor = {
  readonly id: string;
  start: () => Promise<InstanceRuntime>;
  stop: () => void;
  restart: () => Promise<InstanceRuntime>;
  sendCommand: (command: string) => void;
  sendRawInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  getRuntime: () => InstanceRuntime;
  onData: (listener: (chunk: string) => void) => () => void;
};
