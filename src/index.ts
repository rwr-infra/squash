import pino from 'pino';
import { bootstrapApp } from './app/bootstrap.js';
import { createInstanceConfigStore } from './core/config/instance-config-store.js';
import { createInstanceRegistry } from './core/instance/instance-registry.js';
import { InstanceService } from './services/instance-service.js';
import { LogService } from './services/log-service.js';
import { TerminalService } from './services/terminal-service.js';
import { createHttpServer } from './api/http/http-server.js';
import { createTerminalGateway } from './api/ws/terminal-gateway.js';

const logger = pino({
  name: 'rwr-terminal-proxy',
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime
});

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

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

  const httpServer = await createHttpServer({ instanceService, logService, terminalService, terminalGateway });

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
