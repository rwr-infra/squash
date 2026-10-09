import { z } from 'zod';

// The constraints of CreateInstanceSchema, without its defaults: a template
// keeps only the fields that were filled in. Creating an instance from it
// still goes through CreateInstanceSchema.
export const TemplateValuesSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  cwd: z.string().min(1).optional(),
  executable: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  autoStart: z.boolean().optional(),
  restartPolicy: z.enum(['never', 'on-failure', 'always']).optional(),
  restartDelayMs: z.number().int().min(0).optional(),
  stopCommand: z.string().optional(),
  stopTimeoutMs: z.number().int().min(1000).max(600_000).optional()
}).strict();

// Body of POST /templates and PUT /templates/:id (a full replacement).
export const TemplateBodySchema = z.object({
  name: z.string().trim().min(1).max(128),
  values: TemplateValuesSchema.default({})
}).strict();

export type TemplateBody = z.infer<typeof TemplateBodySchema>;

export const TemplateIdParamSchema = z.object({
  id: z.string().min(1)
});

export type TemplateIdParam = z.infer<typeof TemplateIdParamSchema>;
