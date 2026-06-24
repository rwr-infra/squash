import { randomUUID } from 'node:crypto';
import pino from 'pino';

// Default credentials used when the operator hasn't set AUTH_USERNAME /
// AUTH_PASSWORD. We deliberately default login ON (rather than leaving the
// panel open) so that a freshly unpacked instance can't be driven by the first
// person to reach its port. These are weak, well-known values — the server
// logs a loud warning at boot when they're in effect, and .env.example tells
// the operator to change them before exposing the server.
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';

const username = process.env.AUTH_USERNAME ?? DEFAULT_USERNAME;
const password = process.env.AUTH_PASSWORD ?? DEFAULT_PASSWORD;
const usingDefaultCredentials =
  process.env.AUTH_USERNAME === undefined || process.env.AUTH_PASSWORD === undefined;
const staticToken = process.env.AUTH_TOKEN;

// Username/password login is enabled when both credentials are configured.
export const isLoginEnabled = Boolean(username && password);
// Any auth at all (login flow OR a static bearer token) gates the API.
export const isAuthEnabled = isLoginEnabled || Boolean(staticToken);
// True when the operator hasn't configured either credential — i.e. the server
// is relying on the well-known admin/admin default. Used to force-loopback
// binding so a default-credentials instance can't be reached from the network.
export const isUsingDefaultCredentials = usingDefaultCredentials;

if (usingDefaultCredentials && isLoginEnabled) {
  pino({ name: 'auth' }).warn(
    `Using default credentials (admin/admin). Set AUTH_USERNAME and AUTH_PASSWORD before exposing this server.`
  );
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Session = { username: string; createdAt: number };
const sessions = new Map<string, Session>();

const tokenFromHeader = (header?: string): string | undefined => {
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : undefined;
};

const sessionUser = (token: string): string | undefined => {
  const session = sessions.get(token);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return undefined;
  }
  return session.username;
};

/** Verifies credentials and issues a session token, or null on failure. */
export const login = (user: string, pass: string): string | null => {
  if (!isLoginEnabled || user !== username || pass !== password) {
    return null;
  }
  const token = randomUUID();
  sessions.set(token, { username: user, createdAt: Date.now() });
  return token;
};

export const logout = (header?: string): void => {
  const token = tokenFromHeader(header);
  if (token) sessions.delete(token);
};

/**
 * Validates an `Authorization: Bearer <token>` header. Accepts both issued
 * session tokens and the static AUTH_TOKEN (backward compatible). When no auth
 * is configured, everything is allowed.
 */
export const validateBearerToken = (header?: string): boolean => {
  if (!isAuthEnabled) return true;
  const token = tokenFromHeader(header);
  if (!token) return false;
  if (sessionUser(token)) return true;
  return Boolean(staticToken) && token === staticToken;
};

/** Resolves the acting user for audit logging. */
export const currentUser = (header?: string): string => {
  const token = tokenFromHeader(header);
  if (token) {
    const user = sessionUser(token);
    if (user) return user;
    if (staticToken && token === staticToken) return 'token';
  }
  return 'anonymous';
};
