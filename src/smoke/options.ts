import path from 'node:path';
import { cwd as getCwd } from 'node:process';
import type { InputMode, SmokeOptions, StopSignal } from './types.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

const requireValue = (value: string | undefined, flag: string) => {
  if (value) {
    return value;
  }

  throw new Error(`Missing value for ${flag}`);
};

const parseNumber = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  throw new Error(`Expected numeric value, received: ${value}`);
};

const parseInputMode = (value: string | undefined): InputMode => {
  if (!value) {
    return 'cr';
  }

  if (value === 'cr') {
    return 'cr';
  }

  if (value === 'lf') {
    return 'lf';
  }

  if (value === 'crlf') {
    return 'crlf';
  }

  throw new Error(`Unsupported --input-mode: ${value}`);
};

const parseStopSignal = (value: string | undefined): StopSignal => {
  if (!value) {
    return 'SIGINT';
  }

  if (value === 'SIGINT') {
    return 'SIGINT';
  }

  if (value === 'SIGTERM') {
    return 'SIGTERM';
  }

  throw new Error(`Unsupported --stop-signal: ${value}`);
};

const parseJsonRecord = (value: string | undefined) => {
  if (!value) {
    return {} as Record<string, string>;
  }

  const parsed = JSON.parse(value) as Record<string, string>;
  return parsed;
};

const parseJsonArray = (value: string | undefined) => {
  if (!value) {
    return [] as string[];
  }

  const parsed = JSON.parse(value) as string[];
  return parsed;
};

const defaultLogFile = () => {
  const stamp = new Date().toISOString().replace(/[:]/g, '-');
  return path.join(getCwd(), 'logs', `pty-smoke-${stamp}.log`);
};

export const helpText = `Usage:\n  npm run smoke:pty -- --cmd ./rwr_server --cwd /srv/rwr/instance-1\n\nOptions:\n  --cmd <value>             Executable or command to run (required)\n  --cwd <value>             Working directory (required)\n  --args-json <json>        JSON string array for args\n  --env-json <json>         JSON string object for extra env vars\n  --input-mode <mode>       cr | lf | crlf (default: cr)\n  --stop-signal <signal>    SIGINT | SIGTERM (default: SIGINT)\n  --stop-timeout-ms <n>     Wait before forced exit summary (default: 5000)\n  --cols <n>                Terminal columns (default: 120)\n  --rows <n>                Terminal rows (default: 40)\n  --log-file <path>         Log output path\n  --help                    Show this help\n\nInteractive commands:\n  /signal SIGINT            Send signal to PTY process pid\n  /signal SIGTERM           Send signal to PTY process pid\n  /raw <text>               Send exact text without line ending\n  /resize <cols> <rows>     Resize PTY\n  /quit                     Exit smoke runner\n  <text>                    Send as command using selected input mode\n`;

export const parseOptions = (argv: readonly string[]): SmokeOptions => {
  const args = [...argv];
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];

    if (flag === '--help') {
      throw new Error(helpText);
    }

    if (!flag.startsWith('--')) {
      throw new Error(`Unexpected argument: ${flag}`);
    }

    values.set(flag, requireValue(args[index + 1], flag));
    index += 1;
  }

  return {
    cmd: requireValue(values.get('--cmd'), '--cmd'),
    cwd: path.resolve(requireValue(values.get('--cwd'), '--cwd')),
    args: parseJsonArray(values.get('--args-json')),
    cols: parseNumber(values.get('--cols'), DEFAULT_COLS),
    rows: parseNumber(values.get('--rows'), DEFAULT_ROWS),
    env: parseJsonRecord(values.get('--env-json')),
    inputMode: parseInputMode(values.get('--input-mode')),
    stopSignal: parseStopSignal(values.get('--stop-signal')),
    stopTimeoutMs: parseNumber(values.get('--stop-timeout-ms'), DEFAULT_STOP_TIMEOUT_MS),
    logFile: values.get('--log-file') ?? defaultLogFile()
  };
};

export const toLineEnding = (mode: InputMode) => {
  if (mode === 'lf') {
    return '\n';
  }

  if (mode === 'crlf') {
    return '\r\n';
  }

  return '\r';
};
