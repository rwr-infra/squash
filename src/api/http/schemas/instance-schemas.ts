import { z } from 'zod';
import { inferServerLogFile, isValidServerLogFile } from '../../../core/log/server-log-file.js';
import { SERVER_LOG_HISTORY_LIMITS } from '../../../core/log/server-log-history.js';

export const SERVER_LOG_FILE_MESSAGE = 'serverLogFile must be a file path inside the working directory (no absolute path, drive or "..")';

// Both limits apply; both are required, so there is always a cap on the files.
export const ServerLogHistorySchema = z.object({
  keepDays: z.number().int().min(SERVER_LOG_HISTORY_LIMITS.keepDays.min).max(SERVER_LOG_HISTORY_LIMITS.keepDays.max),
  keepFiles: z.number().int().min(SERVER_LOG_HISTORY_LIMITS.keepFiles.min).max(SERVER_LOG_HISTORY_LIMITS.keepFiles.max)
}).strict();

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
  restartPolicy: z.enum(['never', 'on-failure', 'always']).optional(),
  restartDelayMs: z.number().int().min(0).default(3000),
  // No schema defaults: an omitted value follows the supervisor's default, so
  // old and new configs alike pick up a change to it.
  stopCommand: z.string().optional(),
  stopTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
  // Relative to cwd; '' = no log viewer. Left out: inferred from the
  // executable, so a client that predates the field keeps rwr_server's log.
  serverLogFile: z.string().refine(value => value === '' || isValidServerLogFile(value), SERVER_LOG_FILE_MESSAGE).optional(),
  // Left out = off: no inference, so no existing instance starts moving its
  // log around on its own.
  serverLogHistory: ServerLogHistorySchema.optional()
}).strict().transform(config => ({ ...config, serverLogFile: config.serverLogFile ?? inferServerLogFile(config.executable) }));

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
