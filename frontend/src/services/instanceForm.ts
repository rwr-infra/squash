import type { CreateInstanceRequest, InstanceTemplateValues, RestartPolicy, ServerLogHistory } from './apiService';

// What the instance and template forms hold: the request's fields, with the
// arguments as the comma-separated text the user types, and keeping previous
// logs as a switch (form only, never sent) plus its limits (blank while
// being typed; only sent with the switch on).
export type InstanceFormValues = Omit<CreateInstanceRequest, 'args' | 'serverLogHistory'> & {
  args?: string;
  keepPreviousLogs?: boolean;
  serverLogHistory?: { keepDays?: number | null; keepFiles?: number | null };
};

// The server's limits for keeping previous logs (src/core/log/
// server-log-history.ts; test/unit/server-log-history.test.ts runs both
// readings against the same cases).
export const SERVER_LOG_HISTORY_LIMITS = {
  keepDays: { min: 1, max: 3650 },
  keepFiles: { min: 1, max: 1000 }
} as const;

// What turning keeping previous logs on fills in: the RWR template's.
export const DEFAULT_SERVER_LOG_HISTORY: ServerLogHistory = { keepDays: 7, keepFiles: 50 };

// One limit: a whole number in its range.
export const isHistoryLimit = (value: unknown, limits: { readonly min: number; readonly max: number }): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= limits.min && value <= limits.max;

// A stored setting as the server reads it (serverLogHistoryOf): both limits
// whole numbers in range, or off.
export const sanitizeServerLogHistory = (value: unknown): ServerLogHistory | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { keepDays, keepFiles } = value as Record<string, unknown>;
  return isHistoryLimit(keepDays, SERVER_LOG_HISTORY_LIMITS.keepDays) && isHistoryLimit(keepFiles, SERVER_LOG_HISTORY_LIMITS.keepFiles)
    ? { keepDays, keepFiles }
    : undefined;
};

// A stored setting as form values: the switch, and the limits — the
// defaults while off, ready for when it is turned on.
export const historyFormValues = (value: unknown): { keepPreviousLogs: boolean; serverLogHistory: ServerLogHistory } => {
  const history = sanitizeServerLogHistory(value);
  return { keepPreviousLogs: history !== undefined, serverLogHistory: history ?? { ...DEFAULT_SERVER_LOG_HISTORY } };
};

// The form's setting: its limits while the switch is on (and both are
// filled in), else none.
export const formToServerLogHistory = (values: Partial<InstanceFormValues>): ServerLogHistory | undefined => {
  const keepDays = values.serverLogHistory?.keepDays;
  const keepFiles = values.serverLogHistory?.keepFiles;
  return values.keepPreviousLogs && typeof keepDays === 'number' && typeof keepFiles === 'number' ? { keepDays, keepFiles } : undefined;
};

// The form values without the fields that are the form's own (the switch)
// or sent in another shape (the limits).
export const withoutHistoryFields = <T extends Partial<InstanceFormValues>>(values: T): Omit<T, 'keepPreviousLogs' | 'serverLogHistory'> => {
  const fields = { ...values };
  delete fields.keepPreviousLogs;
  delete fields.serverLogHistory;
  return fields;
};

const CREATE_DEFAULTS: Partial<InstanceFormValues> = {
  cwd: '.',
  executable: './rwr_server',
  autoStart: false,
  restartPolicy: 'always',
  restartDelayMs: 3000
};

// Every field a template can fill, cleared. Applying a template starts from
// this, so it also clears what a previously applied one filled in. (Typed as a
// full Record so a field added to InstanceTemplateValues must be added here.)
const CLEARED_TEMPLATE_FIELDS: Record<keyof InstanceTemplateValues, undefined> = {
  name: undefined,
  cwd: undefined,
  executable: undefined,
  args: undefined,
  autoStart: undefined,
  restartPolicy: undefined,
  restartDelayMs: undefined,
  stopCommand: undefined,
  stopTimeoutMs: undefined,
  serverLogFile: undefined,
  serverLogHistory: undefined
};

// The form fields a template fills (the limits are two, behind a switch).
export const TEMPLATE_FIELD_PATHS: Array<keyof InstanceFormValues | ['serverLogHistory', 'keepDays' | 'keepFiles']> = [
  ...(Object.keys(CLEARED_TEMPLATE_FIELDS) as Array<keyof InstanceTemplateValues>).filter((name) => name !== 'serverLogHistory'),
  'keepPreviousLogs',
  ['serverLogHistory', 'keepDays'],
  ['serverLogHistory', 'keepFiles']
];

// The server's rules for serverLogFile (src/core/log/server-log-file.ts;
// test/unit/server-log-file.test.ts runs both against the same cases). A file
// name or a path below the working directory, either separator; nothing
// absolute or UNC, no `:` (a drive, an NTFS stream), no segment of only dots
// and spaces (`..`, `.. `) but `.`, no Windows device name.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\.|$)/i;
export const isValidServerLogFile = (value: string): boolean => {
  if (value.length === 0 || value.length > 260 || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\') || value.includes(':')) return false;
  const segments = value.split(/[\\/]/);
  const last = segments[segments.length - 1];
  return (
    segments.every((segment) => (segment === '.' || !/^[. ]+$/.test(segment)) && !WINDOWS_DEVICE.test(segment.replace(/[. ]+$/, ''))) &&
    last !== '' &&
    last !== '.'
  );
};

// What the server infers for an instance without the field: rwr_server's
// log when the executable is rwr_server(.exe), else none.
export const inferServerLogFile = (executable: string | undefined): string =>
  /^rwr_server(\.exe)?$/i.test(executable?.split(/[\\/]/).pop() ?? '') ? 'rwr_server.log' : '';

export const splitArgs = (text: string | undefined): string[] =>
  text ? text.split(',').map((arg) => arg.trim()).filter(Boolean) : [];

const RESTART_POLICIES: readonly RestartPolicy[] = ['never', 'on-failure', 'always'];

const withoutUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;

// The template fields a template sets, valid as the API's template schema
// defines them. templates.json is hand-editable and the server checks only
// its shape: anything else (an `id`, an `env`, args written as one string, a
// stop timeout of 1.5) is dropped rather than allowed to break the form or
// the request built from it.
export const sanitizeTemplateValues = (values: unknown): InstanceTemplateValues => {
  const raw = (typeof values === 'object' && values !== null ? values : {}) as Record<string, unknown>;
  const text = (value: unknown, max = Infinity) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined);
  const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
    (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined);
  return withoutUndefined<InstanceTemplateValues>({
    name: text(raw.name, 128),
    cwd: text(raw.cwd),
    executable: text(raw.executable),
    args: Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === 'string') ? raw.args : undefined,
    autoStart: typeof raw.autoStart === 'boolean' ? raw.autoStart : undefined,
    restartPolicy: RESTART_POLICIES.find((policy) => policy === raw.restartPolicy),
    restartDelayMs: integer(raw.restartDelayMs, 0),
    stopCommand: typeof raw.stopCommand === 'string' ? raw.stopCommand : undefined,
    stopTimeoutMs: integer(raw.stopTimeoutMs, 1000, 600_000),
    serverLogFile: typeof raw.serverLogFile === 'string' && isValidServerLogFile(raw.serverLogFile) ? raw.serverLogFile : undefined,
    serverLogHistory: sanitizeServerLogHistory(raw.serverLogHistory)
  });
};

// Whether picking the template sets the log file (else the create form infers
// it from the executable).
export const templateSetsServerLogFile = (values: InstanceTemplateValues | undefined): boolean =>
  values !== undefined && sanitizeTemplateValues(values).serverLogFile !== undefined;

// A template's values as form values: only the fields it sets.
export const templateToFormValues = (values: InstanceTemplateValues): Partial<InstanceFormValues> => {
  const { args, serverLogHistory, ...rest } = sanitizeTemplateValues(values);
  return {
    ...rest,
    ...(args ? { args: args.join(', ') } : {}),
    ...(serverLogHistory ? { keepPreviousLogs: true, serverLogHistory } : {})
  };
};

// The create form after picking a template (or none): the defaults, overlaid
// with what the template sets. The Instance ID is not part of it. A template
// without a log file (one saved before the field existed, or SteamCMD's)
// gets the one the server would infer from the executable. Previous logs are
// kept only when the template says so.
export const createFormValues = (values?: InstanceTemplateValues): Partial<InstanceFormValues> => {
  const filled = { ...CLEARED_TEMPLATE_FIELDS, ...CREATE_DEFAULTS, ...(values ? templateToFormValues(values) : {}) };
  return {
    ...filled,
    serverLogFile: filled.serverLogFile ?? inferServerLogFile(filled.executable),
    ...historyFormValues(values && sanitizeTemplateValues(values).serverLogHistory)
  };
};

const nonBlank = (text: string | undefined) => (text?.trim() ? text : undefined);

// Form values as template values: only what is filled in. Kept as typed like
// the instance form does (a trailing empty stop command line is an Enter); a
// cleared InputNumber reports null, which means "not set".
export const formToTemplateValues = (values: Partial<InstanceFormValues>): InstanceTemplateValues => {
  const args = splitArgs(values.args);
  const picked: InstanceTemplateValues = {
    name: values.name?.trim() || undefined,
    cwd: nonBlank(values.cwd),
    executable: nonBlank(values.executable),
    args: args.length > 0 ? args : undefined,
    autoStart: values.autoStart ?? undefined,
    restartPolicy: values.restartPolicy ?? undefined,
    restartDelayMs: values.restartDelayMs ?? undefined,
    stopCommand: nonBlank(values.stopCommand),
    stopTimeoutMs: values.stopTimeoutMs ?? undefined,
    serverLogFile: values.serverLogFile?.trim() || undefined,
    serverLogHistory: formToServerLogHistory(values)
  };
  return withoutUndefined(picked);
};

// What a stop command types, one entry per line, parsed the way the
// supervisor does (lines trimmed, leading blank ones skipped): a line plus
// Enter, or a bare Enter. Empty = no stop command.
export const stopCommandKeys = (value: string | undefined): string[] => {
  const lines = (value ?? '').split(/\r?\n|\r/).map((line) => line.trim());
  const first = lines.findIndex((line) => line.length > 0);
  return first === -1 ? [] : lines.slice(first).map((line) => (line ? `${line} ⏎` : '⏎'));
};
