import { z } from 'zod';

// Most matching lines one search returns; the result says when there are more.
export const SERVER_LOG_SEARCH_LIMIT = 10_000;

// A line number or count as written in the query: plain decimal digits
// (z.coerce would take "", " ", "0x10" or "1e3" for numbers).
const decimal = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})$/, 'Expected a non-negative decimal integer')
  .transform(Number)
  .pipe(z.number().max(Number.MAX_SAFE_INTEGER));

// A backup to read instead of the log: a name from the history listing.
// Whether it is one is up to the service, which knows the log's name.
const archive = z.string().min(1).max(512).optional();

export const ServerLogInfoQuerySchema = z.object({ archive });

export type ServerLogInfoQuery = z.infer<typeof ServerLogInfoQuerySchema>;

export const ServerLogLinesQuerySchema = z.object({
  archive,
  from: decimal,
  count: decimal.pipe(z.number().min(1).max(1000)).default(200)
});

export type ServerLogLinesQuery = z.infer<typeof ServerLogLinesQuerySchema>;

export const ServerLogSearchQuerySchema = z.object({
  // A match never spans lines, so a line break could only match nothing.
  // Length in UTF-16 code units, like a JS string or an input's maxLength.
  q: z.string().min(1).max(256).refine(value => !/[\r\n]/.test(value), 'A search cannot contain a line break'),
  caseSensitive: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  archive
});

export type ServerLogSearchQuery = z.infer<typeof ServerLogSearchQuerySchema>;
