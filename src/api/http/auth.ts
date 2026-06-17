import { randomUUID } from 'node:crypto';

const username = process.env.AUTH_USERNAME;
const password = process.env.AUTH_PASSWORD;
const staticToken = process.env.AUTH_TOKEN;

// Username/password login is enabled when both credentials are configured.
export const isLoginEnabled = Boolean(username && password);
// Any auth at all (login flow OR a static bearer token) gates the API.
export const isAuthEnabled = isLoginEnabled || Boolean(staticToken);

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
