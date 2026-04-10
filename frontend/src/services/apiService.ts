const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const unwrap = async <T>(res: Response): Promise<T> => {
  const body = (await res.json()) as ApiResponse<T>;
  if (!body.success || !body.data) {
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
};

export type CreateInstanceRequest = {
  id: string;
  name: string;
  cwd: string;
  executable: string;
  args?: string[];
  env?: Record<string, string>;
  logDir: string;
  autoStart?: boolean;
  autoRestart?: boolean;
  restartDelayMs?: number;
};

export type InstanceWithRuntime = { config: InstanceConfig; runtime: InstanceRuntime };

export const fetchInstances = async (): Promise<InstanceWithRuntime[]> => {
  const res = await fetch(`${API_BASE}/instances`);
  return unwrap(res);
};

export const fetchInstance = async (id: string): Promise<InstanceWithRuntime> => {
  const res = await fetch(`${API_BASE}/instances/${id}`);
  return unwrap(res);
};

export const createInstance = async (data: CreateInstanceRequest): Promise<InstanceConfig> => {
  const res = await fetch(`${API_BASE}/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return unwrap(res);
};

export const startInstance = async (id: string): Promise<InstanceRuntime> => {
  const res = await fetch(`${API_BASE}/instances/${id}/start`, { method: 'POST' });
  return unwrap(res);
};

export const stopInstance = async (id: string): Promise<InstanceRuntime> => {
  const res = await fetch(`${API_BASE}/instances/${id}/stop`, { method: 'POST' });
  return unwrap(res);
};

export const restartInstance = async (id: string): Promise<InstanceRuntime> => {
  const res = await fetch(`${API_BASE}/instances/${id}/restart`, { method: 'POST' });
  return unwrap(res);
};

export const deleteInstance = async (id: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/instances/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json()) as ApiResponse<null>;
    throw new Error(body.error?.message ?? 'Delete failed');
  }
};

export const tailInstanceLogs = async (id: string, lines = 100): Promise<string> => {
  const res = await fetch(`${API_BASE}/instances/${id}/logs/tail?lines=${lines}`);
  return unwrap(res);
};

export const healthCheck = async (): Promise<{ status: string; timestamp: string }> => {
  const res = await fetch(`${API_BASE}/health`);
  return unwrap(res);
};