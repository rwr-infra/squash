// The listen-address gate (CLAUDE.md, "Non-negotiable"): while weakly
// protected, squash never listens on a non-loopback address — an unset HOST
// falls back to 127.0.0.1, an explicit non-loopback HOST is refused.
import { describe, expect, it } from 'vitest';
import { LOOPBACK_HOST, isLoopbackHost, resolveBindHost } from '../../src/app/bind-host.js';

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', ' localhost ', '::1', '127.0.0.1', '127.1.2.3', '127.255.255.254'])('%j is loopback', host => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  // Unusual spellings count as non-loopback, so they are refused rather than trusted.
  it.each([
    '0.0.0.0',
    '::',
    '[::1]',
    '::ffff:127.0.0.1',
    '127.1',
    '127.0.0.1.nip.io',
    'localhost.',
    'fe80::1%lo0',
    '192.168.1.5',
    '10.0.0.1',
    'example.com',
    ''
  ])('%j is not loopback', host => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('resolveBindHost', () => {
  it.each([undefined, '', '   '])('weakly protected, HOST %j: loopback, marked as forced', host => {
    expect(resolveBindHost(host, true)).toEqual({ kind: 'listen', host: LOOPBACK_HOST, forcedLoopback: true });
  });

  it.each([undefined, '', '   '])('strongly protected, HOST %j: all interfaces', host => {
    expect(resolveBindHost(host, false)).toEqual({ kind: 'listen', host: '0.0.0.0', forcedLoopback: false });
  });

  it.each(['0.0.0.0', '::', '192.168.1.5', 'example.com', '[::1]', ' 0.0.0.0 '])('weakly protected, HOST %j: refused', host => {
    expect(resolveBindHost(host, true)).toEqual({ kind: 'refuse', host: host.trim() });
  });

  it.each(['127.0.0.1', 'localhost', '::1', ' 127.0.0.1 '])('weakly protected, loopback HOST %j: allowed as given', host => {
    expect(resolveBindHost(host, true)).toEqual({ kind: 'listen', host: host.trim(), forcedLoopback: false });
  });

  it.each(['0.0.0.0', '::', '192.168.1.5', '127.0.0.1'])('strongly protected, HOST %j: allowed as given', host => {
    expect(resolveBindHost(host, false)).toEqual({ kind: 'listen', host, forcedLoopback: false });
  });
});
