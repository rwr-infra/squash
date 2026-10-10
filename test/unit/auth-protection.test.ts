// isWeaklyProtected decides whether squash may listen beyond loopback
// (src/index.ts feeds it to resolveBindHost). auth.ts reads AUTH_* once, when
// it is first imported, so every case loads a fresh copy of the module.
import { afterEach, describe, expect, it, vi } from 'vitest';

type AuthEnv = { readonly AUTH_USERNAME?: string; readonly AUTH_PASSWORD?: string; readonly AUTH_TOKEN?: string };

const loadAuth = async (env: AuthEnv) => {
  for (const name of ['AUTH_USERNAME', 'AUTH_PASSWORD', 'AUTH_TOKEN'] as const) {
    vi.stubEnv(name, env[name]);
  }
  vi.resetModules();
  return import('../../src/api/http/auth.js');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const STRONG = 'a-long-unguessable-password';

describe('isWeaklyProtected', () => {
  it.each<[string, AuthEnv]>([
    ['nothing set (admin/admin)', {}],
    ['AUTH_PASSWORD=admin written explicitly', { AUTH_USERNAME: 'admin', AUTH_PASSWORD: 'admin' }],
    ['the default password in another case', { AUTH_USERNAME: 'ops', AUTH_PASSWORD: 'ADMIN' }],
    ['the default password padded with whitespace', { AUTH_USERNAME: 'ops', AUTH_PASSWORD: ' admin ' }],
    ['a whitespace-only password', { AUTH_USERNAME: 'ops', AUTH_PASSWORD: '   ' }],
    ['a whitespace-only password next to a static token', { AUTH_USERNAME: 'ops', AUTH_PASSWORD: '   ', AUTH_TOKEN: 'a-static-token' }],
    ['an empty password (login off) and no token', { AUTH_USERNAME: 'ops', AUTH_PASSWORD: '' }],
    ['an empty username (login off) and no token', { AUTH_USERNAME: '', AUTH_PASSWORD: STRONG }],
    ['a static token, password left at the default', { AUTH_TOKEN: 'a-static-token' }],
    ['the default password next to a static token', { AUTH_PASSWORD: 'admin', AUTH_TOKEN: 'a-static-token' }]
  ])('weak: %s', async (_label, env) => {
    expect((await loadAuth(env)).isWeaklyProtected).toBe(true);
  });

  it.each<[string, AuthEnv]>([
    ['a strong password', { AUTH_USERNAME: 'ops', AUTH_PASSWORD: STRONG }],
    ['a strong password, username left at the default', { AUTH_PASSWORD: STRONG }],
    ['a strong password and a static token', { AUTH_USERNAME: 'ops', AUTH_PASSWORD: STRONG, AUTH_TOKEN: 'a-static-token' }],
    ['login off (empty password), a static token only', { AUTH_PASSWORD: '', AUTH_TOKEN: 'a-static-token' }],
    ['login off (empty username), a static token only', { AUTH_USERNAME: '', AUTH_TOKEN: 'a-static-token' }]
  ])('not weak: %s', async (_label, env) => {
    expect((await loadAuth(env)).isWeaklyProtected).toBe(false);
  });
});
