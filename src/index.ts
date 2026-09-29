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
import { isAuthEnabled, isWeaklyProtected } from './api/http/auth.js';
import { resolveBindHost } from './app/bind-host.js';

const logger = pino({
  name: 'rwr-terminal-proxy',
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime
});

const PORT = Number(process.env.PORT ?? 3000);
// While the default password works (or there is no auth at all), whoever reaches
// the port owns every managed server. Such an instance may only listen on
// loopback: an unset HOST falls back to 127.0.0.1, and an explicit non-loopback
// HOST is refused outright (see resolveBindHost).
const bind = resolveBindHost(process.env.HOST, isWeaklyProtected);
const weakReason = isAuthEnabled ? 'the default password (admin) is in use' : 'authentication is disabled';

const main = async () => {
  if (bind.kind === 'refuse') {
    // fatal, not error: must stay visible even with LOG_LEVEL=error/fatal.
    logger.fatal(
      { host: bind.host },
      `Refusing to listen on ${bind.host} because ${weakReason}. Set AUTH_USERNAME and a strong AUTH_PASSWORD (in .env or the environment) before exposing the server, or bind to 127.0.0.1.`
    );
    process.exitCode = 1;
    return;
  }
  if (bind.forcedLoopback) {
    logger.warn(
      `Binding to loopback only because ${weakReason}. Set AUTH_USERNAME and a strong AUTH_PASSWORD to expose the server on the network.`
    );
  }
  const HOST = bind.host;

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
