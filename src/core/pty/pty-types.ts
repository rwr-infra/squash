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
  readonly pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (listener: (chunk: string) => void) => void;
  onExit: (listener: (event: PtyExitInfo) => void) => void;
};
