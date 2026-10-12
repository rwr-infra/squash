// The level of a request's log line (see the onResponse hook in
// createHttpServer): failures stand out, actions show at the default `info`,
// and the page's polling (GETs every few seconds) only with LOG_LEVEL=debug.
export type RequestLogLevel = 'error' | 'warn' | 'info' | 'debug';

const ACTIONS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export const requestLogLevel = (method: string, statusCode: number): RequestLogLevel => {
  // 503: a log file locked or rewritten while read — answered, and the log
  // page asks again every 2 s: a warning, not an error line per poll.
  if (statusCode >= 500 && statusCode !== 503) return 'error';
  // The client went away (an abandoned log search): nothing failed here.
  if (statusCode === 499) return 'debug';
  if (statusCode >= 400) return 'warn';
  return ACTIONS.has(method) ? 'info' : 'debug';
};

// The path only: a query string can carry a secret (the terminal
// WebSocket's ?token=).
export const requestLogPath = (url: string): string => {
  const end = url.indexOf('?');
  return end === -1 ? url : url.slice(0, end);
};

// Fastify and its plugins log URLs too (@fastify/websocket logs a refused
// upgrade's `path`, query included; Fastify logs `req` when a reply can't be
// written): the logger handed to Fastify cuts the query off any `path` or
// `url` field and logs a `req` as its method and path only, and drops the
// raw request bytes a parse error carries (`rawPacket`, which can hold an
// Authorization header).
const withoutQuery = (value: unknown) => (typeof value === 'string' ? requestLogPath(value) : value);
export const requestLogSerializers = (errSerializer: (err: Error) => object) => ({
  path: withoutQuery,
  url: withoutQuery,
  req: (req: { readonly method?: unknown; readonly url?: unknown }) => ({ method: req.method, url: withoutQuery(req.url) }),
  err: (err: Error) => {
    const { rawPacket: _rawPacket, ...rest } = errSerializer(err) as { rawPacket?: unknown };
    return rest;
  }
});
