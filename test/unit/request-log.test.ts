// Request log lines: the level by method and status, the path without its
// query string, and the serializers of the logger handed to Fastify.
import { stdSerializers } from 'pino';
import { describe, expect, it } from 'vitest';
import { requestLogLevel, requestLogPath, requestLogSerializers } from '../../src/api/http/request-log.js';

describe('requestLogLevel', () => {
  it.each([
    ['GET', 200, 'debug'],
    ['HEAD', 200, 'debug'],
    ['OPTIONS', 204, 'debug'],
    ['GET', 304, 'debug'],
    ['POST', 200, 'info'],
    ['POST', 201, 'info'],
    ['PUT', 200, 'info'],
    ['DELETE', 200, 'info'],
    ['PATCH', 200, 'info'],
    ['TRACE', 200, 'debug'],
    ['GET', 401, 'warn'],
    ['POST', 400, 'warn'],
    ['GET', 404, 'warn'],
    ['POST', 409, 'warn'],
    ['GET', 499, 'debug'],
    ['GET', 500, 'error'],
    ['POST', 502, 'error'],
    ['GET', 503, 'warn'],
    ['POST', 503, 'warn']
  ] as const)('%s %i → %s', (method, statusCode, level) => {
    expect(requestLogLevel(method, statusCode)).toBe(level);
  });
});

describe('requestLogPath', () => {
  it.each([
    ['/api/instances', '/api/instances'],
    ['/api/terminal/a?token=secret', '/api/terminal/a'],
    ['/api/instances/a/server-log/search?q=x&caseSensitive=true', '/api/instances/a/server-log/search'],
    ['/?', '/'],
    ['/api/x?a=1?b=2', '/api/x']
  ])('%s → %s', (url, path) => {
    expect(requestLogPath(url)).toBe(path);
  });
});

describe('requestLogSerializers', () => {
  const serializers = requestLogSerializers(stdSerializers.err);
  it('path and url lose their query', () => {
    expect(serializers.path('/api/health?token=secret')).toBe('/api/health');
    expect(serializers.url('/api/terminal/a?token=secret')).toBe('/api/terminal/a');
    expect(serializers.path(undefined)).toBeUndefined();
  });
  it('a request is its method and path only', () => {
    expect(serializers.req({ method: 'GET', url: '/api/terminal/a?token=secret', headers: { authorization: 'Bearer secret' } } as { method: string; url: string })).toEqual({ method: 'GET', url: '/api/terminal/a' });
  });
  it("an error keeps its message and stack but not the request's raw bytes", () => {
    const err = Object.assign(new Error('Parse Error'), { code: 'HPE_INVALID_METHOD', rawPacket: Buffer.from('GET / HTTP/1.1\r\nAuthorization: Bearer secret\r\n') });
    const serialized = serializers.err(err) as Record<string, unknown>;
    expect(serialized).toMatchObject({ message: 'Parse Error', code: 'HPE_INVALID_METHOD', stack: expect.stringContaining('Parse Error') });
    expect(serialized).not.toHaveProperty('rawPacket');
  });
});
