import './app/env.js'; // MUST be first — loads .env before any module reads process.env
import pino from 'pino';
import { bootstrapApp } from './app/bootstrap.js';
import { createInstanceConfigStore } from './core/config/instance-config-store.js';
import { createInstanceRegistry } from './core/instance/instance-registry.js';
import { InstanceService } from './services/instance-service.js';
import { LogService } from './services/log-service.js';
import { TerminalService } from './services/terminal-service.js';
import { AuditService } from './services/audit-service.js';
import { TemplateService } from './services/template-service.js';
import { createTemplateStore } from './core/config/template-store.js';
import { ServerLogService } from './services/server-log-service.js';
import { createHttpServer } from './api/http/http-server.js';
import { createTerminalGateway } from './api/ws/terminal-gateway.js';
import { isAuthEnabled, isWeaklyProtected } from './api/http/auth.js';
import { describeListenError, resolveBindHost } from './app/bind-host.js';
import { resolveStopTimeoutMs } from './core/instance/instance-supervisor.js';

// Once the terminal is gone (window closed, SSH dropped) every write to
// stdout fails with EIO. pino shrugs off only EPIPE: the error would surface
// as an uncaught exception, and its exit-time flushSync retries the failed
// write forever — squash would hang instead of stopping its instances. So
// output is dropped from the first failed write on.
const logDestination = pino.destination({ dest: 1 });
logDestination.on('error', () => {
  logDestination.write = () => true;
  logDestination.flushSync = () => {};
});

const logger = pino(
  {
    name: 'rwr-terminal-proxy',
    level: process.env.LOG_LEVEL ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime
  },
  logDestination
);

const PORT = Number(process.env.PORT ?? 3000);
// While the default password works (or there is no auth at all), whoever reaches
// the port owns every managed server. Such an instance may only listen on
// loopback: an unset HOST falls back to 127.0.0.1, and an explicit non-loopback
// HOST is refused outright (see resolveBindHost).
const bind = resolveBindHost(process.env.HOST, isWeaklyProtected);
const weakReason = isAuthEnabled ? 'the default password (admin) is in use' : 'authentication is disabled';

// On any of these, stop every instance the same way a user Stop does, then
// exit 0 — start.bat treats any other exit code as a failure and pauses.
// SIGHUP: the terminal (on Windows: the console window) was closed; SIGBREAK:
// Ctrl+Break on Windows.
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Shutdown budget: the longest stop timeout plus this. Instances still
// stopping FORCE_KILL_GRACE_MS before the end are force-killed.
const SHUTDOWN_MARGIN_MS = 2000;
const FORCE_KILL_GRACE_MS = 1000;
// Once the instances are down, the HTTP side gets at most this long: a
// WebSocket peer that never answers the close handshake must not hold squash.
const HTTP_CLOSE_GRACE_MS = 1000;
// One action often delivers its signal twice — closing a terminal (the shell
// forwards SIGHUP, then the kernel sends its own), Ctrl+C under npm (npm
// forwards the SIGINT the terminal already sent). Repeats this soon after the
// first are the same request.
const REPEAT_SIGNAL_WINDOW_MS = 1000;

// Resolves true if the promise settles within ms, false otherwise.
const settlesWithin = (promise: Promise<unknown>, ms: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });

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
  const templateService = new TemplateService(await createTemplateStore(app.paths.templateConfigFile));
  const serverLogService = new ServerLogService(registry);

  const httpServer = await createHttpServer({ instanceService, logService, terminalService, terminalGateway, auditService, templateService, serverLogService });

  let shutdownStartedAt: number | undefined;
  // Force-kills every instance still stopping; returns their ids.
  const forceStopAll = () =>
    registry.listSupervisors().flatMap((supervisor) => {
      if (supervisor.getRuntime().status !== 'stopping') return [];
      try {
        supervisor.stop({ force: true });
        return [supervisor.id];
      } catch {
        return []; // Settled in the meantime.
      }
    });

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shutdownStartedAt !== undefined) {
      if (Date.now() - shutdownStartedAt < REPEAT_SIGNAL_WINDOW_MS) {
        return;
      }
      // A deliberate second signal: stop waiting, but leave no orphans.
      logger.warn({ signal, instances: forceStopAll() }, 'Second signal during shutdown; force-killed instances, exiting now');
      process.exit(0);
    }
    shutdownStartedAt = Date.now();
    const supervisors = registry.listSupervisors();
    const budgetMs =
      Math.max(0, ...registry.listConfigs().map((config) => resolveStopTimeoutMs(config.stopTimeoutMs))) + SHUTDOWN_MARGIN_MS;
    const deadline = shutdownStartedAt + budgetMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    logger.info({ signal, instances: supervisors.length, budgetMs }, 'Shutting down: stopping instances');

    // Both at once: dispose() stops each instance and rules out any further
    // start (auto-restarts, a restart still waiting for its old process);
    // close() answers new requests with 503 and ends the WebSocket sessions.
    const instancesStopped = Promise.allSettled(supervisors.map((supervisor) => supervisor.dispose()));
    const httpClosed = httpServer.close().catch((err: unknown) => {
      logger.warn({ err }, 'HTTP server did not close cleanly');
    });
    if (!(await settlesWithin(instancesStopped, budgetMs - FORCE_KILL_GRACE_MS))) {
      logger.warn({ instances: forceStopAll() }, 'Instances still stopping at the shutdown deadline; force-killed them');
      await settlesWithin(instancesStopped, remaining());
    }
    await settlesWithin(httpClosed, Math.min(HTTP_CLOSE_GRACE_MS, remaining()));
    logger.info('Shutdown complete');
    process.exit(0);
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  try {
    await httpServer.listen({ port: PORT, host: HOST });
    logger.info({ port: PORT, host: HOST }, 'HTTP server running');
  } catch (err) {
    if (shutdownStartedAt !== undefined) {
      return; // Closed by a signal while starting to listen; shutdown exits 0.
    }
    logger.fatal({ err }, describeListenError(err, HOST, PORT));
    process.exit(1);
  }

  for (const config of registry.listConfigs()) {
    if (shutdownStartedAt !== undefined) {
      break;
    }
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
  // The message is the actionable part (e.g. bootstrap's "Cannot write to ..."),
  // so put it on msg and log at fatal like the other startup failures.
  logger.fatal({ err: error }, error instanceof Error ? error.message : 'Application bootstrap failed');
  process.exit(1);
});
