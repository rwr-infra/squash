import type { CreateInstanceRequest, InstanceTemplateValues, RestartPolicy } from './apiService';

// What the instance and template forms hold: the request's fields, with the
// arguments as the comma-separated text the user types.
export type InstanceFormValues = Omit<CreateInstanceRequest, 'args'> & { args?: string };

export const CREATE_DEFAULTS: Partial<InstanceFormValues> = {
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
  stopTimeoutMs: undefined
};

export const TEMPLATE_FIELD_NAMES = Object.keys(CLEARED_TEMPLATE_FIELDS) as Array<keyof InstanceTemplateValues>;

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
    stopTimeoutMs: integer(raw.stopTimeoutMs, 1000, 600_000)
  });
};

// A template's values as form values: only the fields it sets.
export const templateToFormValues = (values: InstanceTemplateValues): Partial<InstanceFormValues> => {
  const { args, ...rest } = sanitizeTemplateValues(values);
  return args ? { ...rest, args: args.join(', ') } : rest;
};

// The create form after picking a template (or none): the defaults, overlaid
// with what the template sets. The Instance ID is not part of it.
export const createFormValues = (values?: InstanceTemplateValues): Partial<InstanceFormValues> => ({
  ...CLEARED_TEMPLATE_FIELDS,
  ...CREATE_DEFAULTS,
  ...(values ? templateToFormValues(values) : {})
});

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
    stopTimeoutMs: values.stopTimeoutMs ?? undefined
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
