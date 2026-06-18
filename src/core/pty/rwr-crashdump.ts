import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * RWR's engine installs its own unhandled-exception handler: on a crash it
 * writes <cwd>/rwr_crashdump.dmp and then pops a modal "An unhandled exception
 * occurred!" MessageBox. That dialog HANGS the process in its own message loop —
 * the engine catches the exception before Windows Error Reporting sees it (so no
 * WerFault.exe is involved) and node-pty never sees an exit, so onExit never
 * fires. The dump file's mtime is therefore the precise, low-false-positive
 * signal that a crash just happened and the process is now stuck behind the
 * dialog.
 *
 * Returns the dump file's mtime in epoch-ms, or undefined if no dump exists.
 */
export const CRASH_DUMP_FILENAME = 'rwr_crashdump.dmp';

export const readCrashDumpMtime = async (cwd: string): Promise<number | undefined> => {
  try {
    const info = await stat(join(cwd, CRASH_DUMP_FILENAME));
    return info.mtimeMs;
  } catch {
    // No dump file (the common case) — stat throws ENOENT.
    return undefined;
  }
};
