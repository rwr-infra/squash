import type { WebSocket } from '@fastify/websocket';
import type { InstanceRegistry } from '../../core/instance/instance-registry.js';
import type { TerminalMessage, TerminalPush } from './terminal-types.js';

const parseMessage = (raw: Buffer): TerminalMessage | null => {
  try {
    const msg = JSON.parse(raw.toString()) as TerminalMessage;
    if (msg.type === 'input' && typeof msg.data === 'string') return msg;
    if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') return msg;
    if (msg.type === 'ping') return msg;
    return null;
  } catch {
    return null;
  }
};

const serializePush = (push: TerminalPush): string => JSON.stringify(push);

export const createTerminalGateway = (registry: InstanceRegistry) => {
  const connections = new Map<string, Set<WebSocket>>();

  const getConnections = (instanceId: string): Set<WebSocket> => {
    if (!connections.has(instanceId)) {
      connections.set(instanceId, new Set());
    }
    return connections.get(instanceId)!;
  };

  const broadcast = (instanceId: string, push: TerminalPush, exclude?: WebSocket) => {
    const clients = getConnections(instanceId);
    const payload = serializePush(push);
    for (const client of clients) {
      if (client !== exclude && client.readyState === 1) {
        client.send(payload);
      }
    }
  };

  const handleConnection = (socket: WebSocket, request: { query: { instanceId: string } }) => {
    const { instanceId } = request.query;

    const supervisor = registry.getSupervisor(instanceId);
    if (!supervisor) {
      socket.send(serializePush({ type: 'error', message: `Instance ${instanceId} not found` }));
      socket.close();
      return;
    }

    // Connections are allowed regardless of status: a crashed/stopped instance
    // still has buffered output worth showing (e.g. the crash error). Input is
    // simply ignored until it's running again.
    const runtime = supervisor.getRuntime();
    const clients = getConnections(instanceId);
    clients.add(socket);

    socket.send(serializePush({ type: 'runtime', status: runtime.status, pid: runtime.pid }));

    // Replay recent output so a terminal that attached after a startup burst
    // (e.g. the process printed an error and then crashed) still shows it.
    // A dim divider marks where the buffered history ends and live output begins.
    const backlog = supervisor.getRecentOutput();
    if (backlog) {
      const divider = '\r\n\x1b[90m──────── end of buffered output ────────\x1b[0m\r\n';
      socket.send(serializePush({ type: 'output', data: backlog + divider }));
    }

    const removeListener = supervisor.onData((chunk: string) => {
      if (socket.readyState === 1) {
        socket.send(serializePush({ type: 'output', data: chunk }));
      }
    });

    // Push live status transitions (running → crashed/stopped) so the UI updates
    // without a manual refresh.
    const removeStatus = supervisor.onStatus((rt) => {
      if (socket.readyState === 1) {
        socket.send(serializePush({ type: 'runtime', status: rt.status, pid: rt.pid }));
      }
    });

    const cleanup = () => {
      clients.delete(socket);
      removeListener();
      removeStatus();
    };

    socket.on('message', (raw: Buffer) => {
      const msg = parseMessage(raw);
      if (!msg) return;

      try {
        switch (msg.type) {
          case 'input':
            supervisor.sendRawInput(msg.data);
            break;
          case 'resize':
            supervisor.resize(msg.cols, msg.rows);
            break;
          case 'ping':
            socket.send(serializePush({ type: 'pong' }));
            break;
        }
      } catch {
        // Input/resize on a non-running instance throws InstanceStateError — ignore.
      }
    });

    socket.on('close', () => {
      cleanup();
    });

    socket.on('error', () => {
      cleanup();
    });
  };

  return { handleConnection, broadcast };
};

export type TerminalGateway = ReturnType<typeof createTerminalGateway>;