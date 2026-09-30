import { z } from 'zod';

export const CreateInstanceSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  cwd: z.string().min(1),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  // Defaults to "logs" (relative to the app root), which is the same directory
  // LogService tails from — keep them aligned if you customize this.
  logDir: z.string().min(1).default('logs'),
  autoStart: z.boolean().default(false),
  autoRestart: z.boolean().default(true),
  restartDelayMs: z.number().int().min(0).default(3000),
  // No schema defaults: an omitted value follows the supervisor's default, so
  // old and new configs alike pick up a change to it.
  stopCommand: z.string().optional(),
  stopTimeoutMs: z.number().int().min(1000).max(600_000).optional()
}).strict();

export type CreateInstanceRequest = z.infer<typeof CreateInstanceSchema>;

// Body of POST /instances/:id/stop (optional). `force` only matters while the
// instance is already stopping: it then kills at once.
export const StopInstanceSchema = z.object({
  force: z.boolean().default(false)
}).strict();

export type StopInstanceRequest = z.infer<typeof StopInstanceSchema>;

export const InstanceIdParamSchema = z.object({
  id: z.string().min(1)
});

export type InstanceIdParam = z.infer<typeof InstanceIdParamSchema>;

export const TailLogQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(2000).default(100)
});

export type TailLogQuery = z.infer<typeof TailLogQuerySchema>;

export const SendCommandSchema = z.object({
  command: z.string().min(1),
  appendNewline: z.boolean().default(true),
  captureMs: z.number().int().min(0).max(10000).optional()
}).strict();

export type SendCommandRequest = z.infer<typeof SendCommandSchema>;