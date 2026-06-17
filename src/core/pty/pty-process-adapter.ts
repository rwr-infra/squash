import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import type { PtyProcess, PtyExitInfo, SpawnPtyOptions } from './pty-types.js';

const isWindows = process.platform === 'win32';

/**
 * On Windows a crashed rwr_server.exe can spawn a WerFault.exe child and hang.
 * node-pty's kill() only terminates the ConPTY process, leaving the dialog /
 * fault handler alive. `taskkill /T /F` tears down the whole process tree.
 */
const killProcessTree = (pid: number) => {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
    /* best-effort: process may already be gone */
  });
};

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
      if (isWindows) {
        killProcessTree(ptyProcess.pid);
        return;
      }
      ptyProcess.kill();
    },
    onData: bindData(ptyProcess),
    onExit: bindExit(ptyProcess)
  };
};
