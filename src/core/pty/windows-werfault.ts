import { execFile } from 'node:child_process';

/**
 * Detects whether a Windows Error Reporting fault handler (WerFault.exe) is
 * currently running for a given process — the precise signal that the process
 * has crashed and is hanging behind an error dialog.
 *
 * Note: WerFault.exe is spawned by the WER service (svchost), NOT as a child of
 * the crashed process, so its ParentProcessId is useless here. The crashed
 * process PID is instead passed on WerFault's command line as `-p <pid>`, which
 * is what we match against.
 */
const queryWerFaultCommandLines = (): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='WerFault.exe'\" | Select-Object -ExpandProperty CommandLine"
      ],
      { windowsHide: true, timeout: 4000 },
      (_err, stdout) => {
        resolve(stdout ?? '');
      }
    );
  });

export const detectWerFaultFor = async (pid: number): Promise<boolean> => {
  const stdout = await queryWerFaultCommandLines();
  if (!stdout) {
    return false;
  }

  const pattern = new RegExp(`-p\\s+${pid}\\b`);
  return stdout
    .split(/\r?\n/)
    .some((line) => pattern.test(line));
};
