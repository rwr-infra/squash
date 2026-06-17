const authToken = process.env.AUTH_TOKEN;

export const isAuthEnabled = Boolean(authToken);

/**
 * Validates an `Authorization: Bearer <token>` header against AUTH_TOKEN.
 *
 * When AUTH_TOKEN is not set, auth is disabled and every request is allowed.
 * WebSocket connections (which cannot set headers) pass `Bearer <token>`
 * assembled from a `?token=` query param — see http-server.ts.
 */
export const validateBearerToken = (header?: string): boolean => {
  if (!isAuthEnabled) {
    return true;
  }

  if (!header) {
    return false;
  }

  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token === authToken;
};
