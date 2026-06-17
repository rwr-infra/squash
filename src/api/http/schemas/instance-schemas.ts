import { z } from 'zod';

export const CreateInstanceSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  cwd: z.string().min(1),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  logDir: z.string().min(1),
  autoStart: z.boolean().default(false),
  autoRestart: z.boolean().default(false),
  restartDelayMs: z.number().int().min(0).default(3000)
}).strict();

export type CreateInstanceRequest = z.infer<typeof CreateInstanceSchema>;

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