import './app/env.js'; // MUST be first — loads .env before any module reads process.env
import pino from 'pino';
import { bootstrapApp } from './app/bootstrap.js';
import { createInstanceConfigStore } from './core/config/instance-config-store.js';
import { createInstanceRegistry } from './core/instance/instance-registry.js';
import { InstanceService } from './services/instance-service.js';
import { LogService } from './services/log-service.js';
import { TerminalService } from './services/terminal-service.js';
import { AuditService } from './services/audit-service.js';
import { createHttpServer } from './api/http/http-server.js';
import { createTerminalGateway } from './api/ws/terminal-gateway.js';
import { isUsingDefaultCredentials } from './api/http/auth.js';

const logger = pino({
  name: 'rwr-terminal-proxy',
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime
});

const PORT = Number(process.env.PORT ?? 3000);
// On a default-credentials instance the only thing standing between the network
// and the panel is admin/admin. Force loopback so it can't be reached remotely;
// operators who want to expose the server must set AUTH_USERNAME/AUTH_PASSWORD
// first. An explicit HOST=... still wins, so this never silently overrides a
// deliberate binding choice.
const HOST = process.env.HOST ?? (isUsingDefaultCredentials ? '127.0.0.1' : '0.0.0.0');
if (isUsingDefaultCredentials && process.env.HOST === undefined) {
  logger.warn(
    'Binding to loopback only because default credentials (admin/admin) are in use. Set AUTH_USERNAME and AUTH_PASSWORD to expose the server on the network.'
  );
}

const main = async () => {
  const app = await bootstrapApp();
  logger.info({ paths: app.paths }, 'Application bootstrap complete');

  const configStore = await createInstanceConfigStore();
  const registry = await createInstanceRegistry();
  await registry.loadFromStore(configStore);
  logger.info({ loadedInstances: registry.listConfigs().length }, 'Instance registry loaded');

  const instanceService = new InstanceService(registry, configStore);
  const logService = new LogService();
  const terminalService = new TerminalService(registry);
  const terminalGateway = createTerminalGateway(registry);
  const auditService = new AuditService();

  const httpServer = await createHttpServer({ instanceService, logService, terminalService, terminalGateway, auditService });

  try {
    await httpServer.listen({ port: PORT, host: HOST });
    logger.info({ port: PORT, host: HOST }, 'HTTP server running');
  } catch (err) {
    logger.error({ err }, 'Failed to start HTTP server');
    process.exit(1);
  }

  for (const config of registry.listConfigs()) {
    if (config.autoStart) {
      try {
        await instanceService.startInstance(config.id);
        logger.info({ instanceId: config.id }, 'Auto-started instance');
      } catch (err) {
        logger.error({ err, instanceId: config.id }, 'Failed to auto-start instance');
      }
    }
  }
};

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Application bootstrap failed');
  process.exit(1);
});
