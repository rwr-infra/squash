import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import type { PtyProcess, PtyExitInfo, SpawnPtyOptions } from './pty-types.js';

const isWindows = process.platform === 'win32';
const nodePtyRequire = createRequire(import.meta.url);
const nodePtyVersion: string = nodePtyRequire('node-pty/package.json').version;
const windowsCompatibilityVersion = '1.2.0-beta.12';
// Validate the implementation that creates/exposes conin BEFORE allocating a
// PTY. A version string alone also accepts locally patched private layouts.
const windowsCompatibilityArtifacts = {
  'windowsPtyAgent.js': '1583dc8d41632d0a571d6b3ac27a7d58d445e359ad7799af042de6b5d50d68d0',
  'windowsTerminal.js': 'd6bc0912ecfaf2857651965f887a37bfeb04c745c075e8d10b31cbf661d3aef3'
};

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

export const createPtyProcess = (options: SpawnPtyOptions): PtyProcess => {
  if (isWindows && nodePtyVersion !== windowsCompatibilityVersion) {
    throw new Error(`Windows PTY input cleanup requires node-pty ${windowsCompatibilityVersion}; found ${nodePtyVersion}`);
  }
  if (isWindows) {
    for (const [file, expected] of Object.entries(windowsCompatibilityArtifacts)) {
      const actual = createHash('sha256').update(readFileSync(nodePtyRequire.resolve(`node-pty/lib/${file}`))).digest('hex');
      if (actual !== expected) throw new Error(`Unsupported Windows PTY compatibility artifact: ${file}`);
    }
  }
  const ptyProcess = pty.spawn(resolveCommand(options.command, options.cwd), [...options.args], {
    name: options.name,
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: { ...options.env }
  });

  let exited = false;
  let inputSocket: Socket | undefined;
  const exitListeners = new Set<(event: PtyExitInfo) => void>();
  if (isWindows) {
    // Version-bound workaround for microsoft/node-pty#947. The public IPty
    // API cannot close conin; keep the private access at this adapter boundary.
    // The exact verified constructor creates a net.Socket at this field. Do
    // not reject a private shape after spawning: public kill can defer forever
    // for a quiet child, leaving failed-spawn resources unmanaged.
    inputSocket = (ptyProcess as pty.IPty & { _agent: { inSocket: Socket } })._agent.inSocket;
    inputSocket.on('error', (error: NodeJS.ErrnoException) => {
      // Destroying pending writes after exit can report a closed pipe. Keep
      // active-session and unexpected errors fail-fast rather than hiding them.
      if (exited && ['ERR_STREAM_DESTROYED', 'ERR_SOCKET_CLOSED', 'EPIPE', 'EBADF'].includes(error.code ?? '')) return;
      throw error;
    });
  }
  ptyProcess.onExit(({ exitCode, signal }) => {
    if (exited) return;
    exited = true;
    // Output has already flushed before node-pty emits exit. Closing only the
    // input now discards writes to a dead process without interrupting output.
    inputSocket?.destroy();
    inputSocket = undefined;
    for (const listener of exitListeners) listener({ exitCode, signal });
    exitListeners.clear();
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
      if (exited) return;
      ptyProcess.write(data);
    },
    resize: (cols, rows) => {
      if (exited) return;
      ptyProcess.resize(cols, rows);
    },
    kill: (mode) => {
      if (exited) return;
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
    onExit: (listener) => { if (!exited) exitListeners.add(listener); }
  };
};
