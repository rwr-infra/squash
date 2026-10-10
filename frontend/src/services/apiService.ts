// All backend endpoints live under /api. Default to a relative base so the
// production build — served same-origin by the backend (npm start / Docker /
// portable bundle) — calls the API on whatever origin served the page.
// VITE_API_URL is only an override for the split dev setup (vite on :5173 talking
// to the backend on another port); the /api prefix is always appended.
const API_BASE = `${import.meta.env.VITE_API_URL ?? ''}/api`;
const TOKEN_KEY = 'squash_token';

// Token is obtained at runtime via login and persisted in localStorage. A
// build-time VITE_AUTH_TOKEN still works as a fallback (static-token setups).
export const getToken = (): string =>
  localStorage.getItem(TOKEN_KEY) ?? import.meta.env.VITE_AUTH_TOKEN ?? '';
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

const authHeaders = (): Record<string, string> => {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export const UNAUTHORIZED_EVENT = 'squash:unauthorized';

// On a 401 from an authenticated endpoint, drop the (now invalid) token and let
// the app react (toast + redirect to /login). The login endpoint handles its own
// 401 separately so a wrong password doesn't trigger this.
const assertAuthorized = (res: Response) => {
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error('Unauthorized');
  }
};

// Carries the API's error code (e.g. TEMPLATE_NAME_TAKEN) so callers can react
// to a specific failure; the message is the API's own.
export class ApiError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

const unwrap = async <T>(res: Response): Promise<T> => {
  assertAuthorized(res);
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.success || body.data === undefined) {
    throw new ApiError(body.error?.code, body.error?.message ?? 'Unknown API error');
  }
  return body.data;
};

export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
export type RestartPolicy = 'never' | 'on-failure' | 'always';
export type RestartReason = 'unexpected-exit' | 'disabled' | 'clean-exit' | 'manual-stop' | 'retry-limit' | 'spawn-failed';

export type InstanceConfig = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly logDir: string;
  readonly autoStart?: boolean;
  readonly autoRestart?: boolean;
  readonly restartPolicy?: RestartPolicy;
  readonly restartDelayMs?: number;
  readonly stopCommand?: string;
  readonly stopTimeoutMs?: number;
};

export type InstanceRuntime = {
  readonly id: string;
  readonly status: InstanceStatus;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly lastOutputAt?: string;
  readonly exitCode?: number;
  readonly exitSignal?: number;
  readonly viewers: number;
  readonly restartCount?: number;
  readonly desiredState?: 'running' | 'stopped';
  readonly restartAt?: string;
  readonly restartReason?: RestartReason;
};

export type CreateInstanceRequest = {
  id: string;
  name?: string;
  cwd: string;
  executable: string;
  args?: string[];
  env?: Record<string, string>;
  logDir?: string;
  autoStart?: boolean;
  autoRestart?: boolean;
  restartPolicy?: RestartPolicy;
  restartDelayMs?: number;
  stopCommand?: string;
  stopTimeoutMs?: number;
};

export type InstanceWithRuntime = { config: InstanceConfig; runtime: InstanceRuntime };

export const fetchInstances = async (): Promise<InstanceWithRuntime[]> => {
  const res = await fetch(`${API_BASE}/instances`, { headers: authHeaders() });
  return unwrap(res);
};

export const fetchInstance = async (id: string): Promise<InstanceWithRuntime> => {
  const res = await fetch(`${API_BASE}/instances/${id}`, { headers: authHeaders() });
  return unwrap(res);
};

export const createInstance = async (data: CreateInstanceRequest): Promise<InstanceConfig> => {
  const res = await fetch(`${API_BASE}/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data)
  });
  return unwrap(res);
};

export const updateInstance = async (id: string, data: CreateInstanceRequest): Promise<InstanceConfig> => {
  const res = await fetch(`${API_BASE}/instances/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data)
  });
  return unwrap(res);
};

export const startInstance = async (id: string): Promise<InstanceRuntime> => {
  const res = await fetch(`${API_BASE}/instances/${id}/start`, { method: 'POST', headers: authHeaders() });
  return unwrap(res);
};

// `force` only matters while the instance is already stopping: it then kills
// at once. Without it a repeated Stop leaves a graceful stop alone.
export const stopInstance = async (id: string, opts: { force?: boolean } = {}): Promise<InstanceRuntime> => {
  const res = await fetch(`${API_BASE}/instances/${id}/stop`, opts.force
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ force: true }) }
    : { method: 'POST', headers: authHeaders() });
  return unwrap(res);
};

export const restartInstance = async (id: string): Promise<InstanceRuntime> => {
  const res = await fetch(`${API_BASE}/instances/${id}/restart`, { method: 'POST', headers: authHeaders() });
  return unwrap(res);
};

export const deleteInstance = async (id: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/instances/${id}`, { method: 'DELETE', headers: authHeaders() });
  assertAuthorized(res);
  if (!res.ok) {
    const body = (await res.json()) as ApiResponse<null>;
    throw new Error(body.error?.message ?? 'Delete failed');
  }
};

export type SendCommandOptions = { appendNewline?: boolean; captureMs?: number };

export const sendCommand = async (
  id: string,
  command: string,
  opts: SendCommandOptions = {}
): Promise<{ output?: string; accepted?: boolean }> => {
  const res = await fetch(`${API_BASE}/instances/${id}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ command, ...opts })
  });
  return unwrap(res);
};

export const tailInstanceLogs = async (id: string, lines = 100): Promise<string> => {
  const res = await fetch(`${API_BASE}/instances/${id}/logs/tail?lines=${lines}`, { headers: authHeaders() });
  return unwrap(res);
};

export const healthCheck = async (): Promise<{ status: string; timestamp: string }> => {
  const res = await fetch(`${API_BASE}/health`);
  return unwrap(res);
};

// --- Auth ---

export const getAuthStatus = async (): Promise<{ loginEnabled: boolean }> => {
  const res = await fetch(`${API_BASE}/auth/status`);
  return unwrap(res);
};

export const login = async (username: string, password: string): Promise<{ token: string; username: string }> => {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  // Parse manually (no assertAuthorized): a 401 here means wrong credentials,
  // which the login page surfaces — it must not trigger the global redirect.
  const body = (await res.json()) as ApiResponse<{ token: string; username: string }>;
  if (!body.success || !body.data) {
    throw new Error(body.error?.message ?? 'Invalid username or password');
  }
  return body.data;
};

export const getMe = async (): Promise<{ username: string }> => {
  const res = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
  return unwrap(res);
};

export const logout = async (): Promise<void> => {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: authHeaders() });
  } finally {
    clearToken();
  }
};

// --- Templates ---

// The instance settings a template prefills: the instance form's fields
// except the ID, each optional.
export type InstanceTemplateValues = Partial<
  Pick<CreateInstanceRequest, 'name' | 'cwd' | 'executable' | 'args' | 'autoStart' | 'restartPolicy' | 'restartDelayMs' | 'stopCommand' | 'stopTimeoutMs'>
>;

export type InstanceTemplate = {
  readonly id: string;
  readonly name: string;
  readonly values: InstanceTemplateValues;
};

export type TemplateRequest = { name: string; values: InstanceTemplateValues };

export const fetchTemplates = async (): Promise<InstanceTemplate[]> => {
  const res = await fetch(`${API_BASE}/templates`, { headers: authHeaders() });
  return unwrap(res);
};

export const createTemplate = async (data: TemplateRequest): Promise<InstanceTemplate> => {
  const res = await fetch(`${API_BASE}/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data)
  });
  return unwrap(res);
};

export const updateTemplate = async (id: string, data: TemplateRequest): Promise<InstanceTemplate> => {
  const res = await fetch(`${API_BASE}/templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data)
  });
  return unwrap(res);
};

export const deleteTemplate = async (id: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/templates/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
  await unwrap(res);
};

// --- Audit ---

export type AuditEntry = {
  time: string;
  user: string;
  action: 'login' | 'logout' | 'create' | 'start' | 'stop' | 'restart' | 'delete' | 'command';
  instanceId?: string;
  detail?: string;
};

export const fetchAudit = async (limit = 100): Promise<AuditEntry[]> => {
  const res = await fetch(`${API_BASE}/audit?limit=${limit}`, { headers: authHeaders() });
  return unwrap(res);
};

// --- rwr_server.log ---

// What the server's index covers. `generation` changes whenever the file was
// emptied or replaced (rwr_server clears it on every start): line numbers
// and search results from another generation describe other content. An
// append can complete a partial last line: read it again when `size` grows.
export type ServerLogSnapshot = {
  exists: boolean;
  size: number;
  lineCount: number;
  generation: string;
  modifiedAt?: string;
};

export type ServerLogInfo = ServerLogSnapshot & { path: string };
export type ServerLogLines = ServerLogSnapshot & { from: number; lines: string[] };
export type ServerLogSearchResult = ServerLogSnapshot & { matches: number[]; truncated: boolean };

const serverLogUrl = (id: string) => `${API_BASE}/instances/${encodeURIComponent(id)}/server-log`;

export const fetchServerLogInfo = async (id: string): Promise<ServerLogInfo> => {
  const res = await fetch(serverLogUrl(id), { headers: authHeaders() });
  return unwrap(res);
};

export const fetchServerLogLines = async (id: string, from: number, count: number, signal?: AbortSignal): Promise<ServerLogLines> => {
  const res = await fetch(`${serverLogUrl(id)}/lines?from=${from}&count=${count}`, { headers: authHeaders(), signal });
  return unwrap(res);
};

// Matching line numbers (0-based) over the whole file, at most 10,000.
export const searchServerLog = async (id: string, query: string, caseSensitive: boolean, signal?: AbortSignal): Promise<ServerLogSearchResult> => {
  const params = new URLSearchParams({ q: query, caseSensitive: String(caseSensitive) });
  const res = await fetch(`${serverLogUrl(id)}/search?${params}`, { headers: authHeaders(), signal });
  return unwrap(res);
};
