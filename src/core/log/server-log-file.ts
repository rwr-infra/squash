import path from 'node:path';

// The file an instance's log viewer reads: InstanceConfig.serverLogFile, a
// path relative to the instance's working directory ('' = no log viewer).
// It comes from the instance's config only — no request names a file.

// rwr_server writes its own log next to itself — in its working directory,
// like rwr_crashdump.dmp — and empties it whenever it starts.
export const RWR_SERVER_LOG_FILE = 'rwr_server.log';

export const SERVER_LOG_FILE_MAX_LENGTH = 260;

// A file name, or a path below the working directory (either separator).
// Nothing that reaches out of it — no absolute or UNC path, no `:` anywhere
// (a drive: `C:x`, also mid-path, where Windows resolves `x/C:..` on drive C;
// or an NTFS stream), no `..` segment — and nothing that ends in a directory.
// Checked on both platforms' rules: a config may move between them. Windows
// may drop a segment's trailing dots and spaces (`.. ` → `..`), so a segment
// of only dots and spaces counts as `..` — except `.` itself — and a device
// name (`NUL`, `com1.log`) is no file.
export const isValidServerLogFile = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > SERVER_LOG_FILE_MAX_LENGTH || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\') || value.includes(':')) return false;
  const segments = serverLogFileSegments(value);
  const last = segments[segments.length - 1];
  return (
    segments.every(segment => (segment === '.' || !/^[. ]+$/.test(segment)) && !WINDOWS_DEVICE.test(segment.replace(/[. ]+$/, ''))) &&
    last !== '' &&
    last !== '.'
  );
};

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\.|$)/i;

// Either separator, on every platform: resolve the segments, not the text.
export const serverLogFileSegments = (value: string): string[] => value.split(/[\\/]/);

// For a config saved before the field existed, or a request that leaves it
// out: rwr_server's log when the executable is rwr_server, else none.
export const inferServerLogFile = (executable: unknown): string => {
  if (typeof executable !== 'string') return '';
  const name = executable.split(/[\\/]/).pop() ?? '';
  return /^rwr_server(\.exe)?$/i.test(name) ? RWR_SERVER_LOG_FILE : '';
};

// The config's log file, inferred when the field is missing. A hand-edited
// value that isn't text means none.
export const serverLogFileOf = (config: { readonly executable?: unknown; readonly serverLogFile?: unknown }): string => {
  if (config.serverLogFile === undefined) return inferServerLogFile(config.executable);
  return typeof config.serverLogFile === 'string' ? config.serverLogFile : '';
};

// The config's log file as an absolute path; undefined when it has none, or
// (a hand-edited config) one that is not a path inside its working directory.
// The rules keep it inside; the check after resolving makes sure.
export const resolveServerLogPath = (config: { readonly cwd: string; readonly executable?: unknown; readonly serverLogFile?: unknown }): string | undefined => {
  const file = serverLogFileOf(config);
  if (!isValidServerLogFile(file)) return undefined;
  const cwd = path.resolve(config.cwd);
  const filePath = path.resolve(cwd, ...serverLogFileSegments(file));
  const relative = path.relative(cwd, filePath);
  return relative === '' || path.isAbsolute(relative) || relative.split(path.sep)[0] === '..' ? undefined : filePath;
};
