import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { PtyProcess, PtyExitInfo, SpawnPtyOptions } from './pty-types.js';

const isWindows = process.platform === 'win32';

/**
 * Resolve the command into a form node-pty can actually spawn on this platform.
 *
 * node-pty on Windows ultimately calls `CreateProcessW`, which does NOT resolve a
 * relative executable path (e.g. `./rwr_server.exe`) against `cwd` the way Node's
 * `child_process` does — it fails with "File not found" (ERROR_FILE_NOT_FOUND)
 * even when the binary is sitting right in the working directory. So we resolve
 * any relative path against `cwd` to an absolute one before handing it over.
 * Absolute paths and bare names (left to the OS PATH search) are passed through.
 */
const resolveCommand = (command: string, cwd: string): string => {
  // Bare name (no separators, no `.`/`..` segment) — let CreateProcessW do its
  // own PATH lookup; resolving it ourselves would only break that.
  if (path.isAbsolute(command) || (!command.includes('/') && !command.includes('\\'))) {
    return command;
  }
  const absolute = path.resolve(cwd, command);
  // On Windows, if the user wrote a relative path without an extension, the
  // actual binary almost always has `.exe` — try that suffix so `./rwr_server`
  // works the same way it does on macOS/Linux.
  if (isWindows && path.extname(absolute) === '') {
    const withExe = `${absolute}.exe`;
    if (existsSync(withExe)) {
      return withExe;
    }
  }
  return absolute;
};

/**
 * On Windows a crashed rwr_server.exe hangs behind a modal crash dialog (the
 * engine's own "An unhandled exception occurred!" box). node-pty's kill() only
 * terminates the ConPTY process, leaving the hung process and its dialog alive.
 * `taskkill /T /F` (TerminateProcess) tears down the whole process tree,
 * including a process stuck in a MessageBox message loop.
 */
const killProcessTree = (pid: number) => {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
    /* best-effort: process may already be gone */
  });
};

/**
 * The PTY child is a session leader (forkpty on Linux, posix_spawn with
 * POSIX_SPAWN_SETSID on macOS), so its PID is also its process group ID:
 * signalling -pid reaches whatever a wrapper script spawned, like `taskkill /T`
 * does on Windows. Falls back to the PID alone if the group is already gone.
 */
const killProcessGroup = (pid: number) => {
  // process.kill(-0) would signal squash's *own* process group, and -1 every
  // process this user may signal.
  if (pid <= 1) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
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
  const ptyProcess = pty.spawn(resolveCommand(options.command, options.cwd), [...options.args], {
    name: options.name,
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: { ...options.env }
  });

  return {
    // Live getter, not a snapshot: on Windows node-pty fills the child PID
    // asynchronously after spawn (see windowsTerminal.js — `_pid` is updated
    // on the socket's `ready_datapipe` event), so capturing `ptyProcess.pid`
    // once here would freeze the placeholder 0 forever. Reading it live each
    // time returns the real PID once ConPTY connects.
    get pid() {
      return ptyProcess.pid;
    },
    write: (data) => {
      ptyProcess.write(data);
    },
    resize: (cols, rows) => {
      ptyProcess.resize(cols, rows);
    },
    kill: (mode) => {
      if (isWindows) {
        // Until ConPTY is ready the PID is the placeholder 0 (see `pid` above)
        // and `taskkill /PID 0` does nothing; node-pty queues its own kill
        // until then.
        if (ptyProcess.pid <= 0) {
          ptyProcess.kill();
          return;
        }
        killProcessTree(ptyProcess.pid);
        return;
      }
      if (mode === 'force') {
        killProcessGroup(ptyProcess.pid);
        return;
      }
      // node-pty's default: SIGHUP to the child only (errors swallowed).
      ptyProcess.kill();
    },
    onData: bindData(ptyProcess),
    onExit: bindExit(ptyProcess)
  };
};
