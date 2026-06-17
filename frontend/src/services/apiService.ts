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

const unwrap = async <T>(res: Response): Promise<T> => {
  assertAuthorized(res);
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.success || body.data === undefined) {
    throw new Error(body.error?.message ?? 'Unknown API error');
  }
  return body.data;
};

export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

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
  readonly restartDelayMs?: number;
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
  restartDelayMs?: number;
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

export const stopInstance = async (id: string): Promise<InstanceRuntime> => {
  const res = await fetch(`${API_BASE}/instances/${id}/stop`, { method: 'POST', headers: authHeaders() });
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