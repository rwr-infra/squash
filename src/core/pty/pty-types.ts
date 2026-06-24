export type SpawnPtyOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cols: number;
  readonly rows: number;
  readonly name: string;
};

export type PtyExitInfo = {
  readonly exitCode: number;
  readonly signal?: number;
};

export type PtyProcess = {
  // On Windows the child PID is filled in asynchronously by node-pty AFTER
  // spawn returns (the ConPTY data pipe isn't ready yet at construction), so
  // this MUST be read live each time — a one-time snapshot captured at spawn
  // would freeze the initial placeholder (0) forever.
  readonly pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (listener: (chunk: string) => void) => void;
  onExit: (listener: (event: PtyExitInfo) => void) => void;
};
