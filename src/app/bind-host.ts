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

/** Turns a failed `listen()` into an actionable message for the operator. */
export const describeListenError = (err: unknown, host: string, port: number): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'EADDRINUSE':
      return `Port ${port} is already in use on ${host}. Stop the other program using it, or set a different PORT (in .env or the environment).`;
    case 'EACCES':
      // Windows has no privileged ports; there EACCES usually means the port sits
      // in a range reserved by Hyper-V/WSL/WinNAT (3000 often is).
      if (process.platform === 'win32') {
        return `No permission to listen on ${host}:${port}. The port may be reserved by Windows (check \`netsh interface ipv4 show excludedportrange protocol=tcp\`) — set a different PORT.`;
      }
      return port < 1024
        ? `No permission to listen on ${host}:${port}. Ports below 1024 need elevated privileges — set a higher PORT.`
        : `No permission to listen on ${host}:${port} (blocked by the OS or a security policy) — set a different PORT.`;
    case 'EADDRNOTAVAIL':
    case 'ENOTFOUND':
      return `Address ${host} is not available on this machine. Check HOST (unset it to use the default).`;
    default:
      return 'Failed to start HTTP server';
  }
};
