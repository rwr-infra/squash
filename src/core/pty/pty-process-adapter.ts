import * as pty from 'node-pty';
import type { PtyProcess, PtyExitInfo, SpawnPtyOptions } from './pty-types.js';

const bindData = (ptyProcess: pty.IPty) => (listener: (chunk: string) => void) => {
  ptyProcess.onData(listener);
};

const bindExit = (ptyProcess: pty.IPty) => (listener: (event: PtyExitInfo) => void) => {
  ptyProcess.onExit(({ exitCode, signal }) => {
    listener({ exitCode, signal });
  });
};

export const createPtyProcess = (options: SpawnPtyOptions): PtyProcess => {
  const ptyProcess = pty.spawn(options.command, [...options.args], {
    name: options.name,
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: { ...options.env }
  });

  return {
    pid: ptyProcess.pid,
    write: (data) => {
      ptyProcess.write(data);
    },
    resize: (cols, rows) => {
      ptyProcess.resize(cols, rows);
    },
    kill: () => {
      ptyProcess.kill();
    },
    onData: bindData(ptyProcess),
    onExit: bindExit(ptyProcess)
  };
};
