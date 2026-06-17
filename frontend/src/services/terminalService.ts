export type TerminalMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type TerminalPush =
  | { type: 'output'; data: string }
  | { type: 'pong' }
  | { type: 'error'; message: string }
  | { type: 'runtime'; status: string; pid?: number };

export type TerminalHandlers = {
  onOutput: (data: string) => void;
  onRuntime: (runtime: { status: string; pid?: number }) => void;
  onError: (message: string) => void;
  onClose: () => void;
};

import { getToken } from './apiService';

// Same-origin WebSocket by default (derived from the page's location), so the
// production build talks to whatever host served it. VITE_WS_URL overrides this
// for the split dev setup.
const sameOriginWs = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
const WS_BASE = import.meta.env.VITE_WS_URL ?? sameOriginWs;
const MAX_RETRIES = 3;

export const connectTerminal = (
  instanceId: string,
  handlers: TerminalHandlers
): { send: (msg: TerminalMessage) => void; disconnect: () => void } => {
  let retries = 0;
  let ws: WebSocket | null = null;
  let disposed = false;

  const token = getToken();
  const wsUrl = token
    ? `${WS_BASE}/api/terminal/${instanceId}?token=${encodeURIComponent(token)}`
    : `${WS_BASE}/api/terminal/${instanceId}`;

  const connect = () => {
    if (disposed) return;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      retries = 0;
    };

    ws.onmessage = (event) => {
      try {
        const push = JSON.parse(event.data as string) as TerminalPush;
        switch (push.type) {
          case 'output':
            handlers.onOutput(push.data);
            break;
          case 'runtime':
            handlers.onRuntime({ status: push.status, pid: push.pid });
            break;
          case 'error':
            handlers.onError(push.message);
            break;
          case 'pong':
            break;
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      if (disposed) return;
      if (retries < MAX_RETRIES) {
        retries++;
        setTimeout(connect, 1000 * retries);
      } else {
        handlers.onClose();
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  };

  connect();

  return {
    send: (msg: TerminalMessage) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    disconnect: () => {
      disposed = true;
      ws?.close();
    }
  };
};