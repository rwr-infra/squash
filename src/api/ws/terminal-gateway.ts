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

    const runtime = supervisor.getRuntime();
    if (runtime.status !== 'running' && runtime.status !== 'starting') {
      socket.send(
        serializePush({ type: 'error', message: `Instance ${instanceId} is not running (status: ${runtime.status})` })
      );
      socket.close();
      return;
    }

    const clients = getConnections(instanceId);
    clients.add(socket);

    socket.send(serializePush({ type: 'runtime', status: runtime.status, pid: runtime.pid }));

    const removeListener = supervisor.onData((chunk: string) => {
      if (socket.readyState === 1) {
        socket.send(serializePush({ type: 'output', data: chunk }));
      }
    });

    socket.on('message', (raw: Buffer) => {
      const msg = parseMessage(raw);
      if (!msg) return;

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
    });

    socket.on('close', () => {
      clients.delete(socket);
      removeListener();
    });

    socket.on('error', () => {
      clients.delete(socket);
      removeListener();
    });
  };

  return { handleConnection, broadcast };
};

export type TerminalGateway = ReturnType<typeof createTerminalGateway>;