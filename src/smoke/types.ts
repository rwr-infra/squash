export type InputMode = 'cr' | 'lf' | 'crlf';

export type StopSignal = 'SIGINT' | 'SIGTERM';

export type SmokeOptions = {
  readonly cmd: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
  readonly inputMode: InputMode;
  readonly stopSignal: StopSignal;
  readonly stopTimeoutMs: number;
  readonly logFile: string;
};

export type SmokeState = {
  readonly observedAnsi: boolean;
  readonly pid?: number;
};
