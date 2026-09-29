import net from 'node:net';

export const LOOPBACK_HOST = '127.0.0.1';

export type BindDecision =
  | { readonly kind: 'listen'; readonly host: string; readonly forcedLoopback: boolean }
  | { readonly kind: 'refuse'; readonly host: string };

// Only 127.0.0.0/8, `::1` and the `localhost` name. Everything else — 0.0.0.0,
// ::, LAN addresses, other hostnames, bracketed or zone-qualified forms — counts
// as non-loopback, so an unusual spelling is refused rather than trusted.
export const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  return net.isIPv4(normalized) && normalized.startsWith('127.');
};

/**
 * Decides where the HTTP server may listen.
 *
 * - Unset/empty HOST: loopback when weakly protected, all interfaces otherwise.
 * - Explicit loopback HOST: always allowed.
 * - Explicit non-loopback HOST while weakly protected: refused. Silently forcing
 *   loopback instead would leave e.g. a Docker port mapping pointing at nothing,
 *   which is harder to diagnose than a clear startup error.
 */
export const resolveBindHost = (explicitHost: string | undefined, weaklyProtected: boolean): BindDecision => {
  const host = explicitHost?.trim();
  if (!host) {
    return weaklyProtected
      ? { kind: 'listen', host: LOOPBACK_HOST, forcedLoopback: true }
      : { kind: 'listen', host: '0.0.0.0', forcedLoopback: false };
  }
  if (weaklyProtected && !isLoopbackHost(host)) {
    return { kind: 'refuse', host };
  }
  return { kind: 'listen', host, forcedLoopback: false };
};
