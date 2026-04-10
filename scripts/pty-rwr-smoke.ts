#!/usr/bin/env node
import readline from 'node:readline';
import process from 'node:process';
import pino from 'pino';
import * as pty from 'node-pty';
import { createLineBuffer } from '../src/smoke/line-buffer.js';
import { createLogWriter } from '../src/smoke/log-writer.js';
import { helpText, parseOptions, toLineEnding } from '../src/smoke/options.js';

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/;

const logger = pino({
  name: 'pty-smoke',
  level: 'info',
  timestamp: pino.stdTimeFunctions.isoTime
});

const printSummary = (summary: Record<string, unknown>) => {
  logger.info(summary, 'Smoke test summary');
};

const run = async () => {
  const options = parseOptions(process.argv.slice(2));
  const lineBuffer = createLineBuffer();
  const logWriter = await createLogWriter(options.logFile);
  let observedAnsi = false;

  const ptyProcess = pty.spawn(options.cmd, [...options.args], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: { ...process.env, ...options.env }
  });

  logger.info(
    {
      pid: ptyProcess.pid,
      cmd: options.cmd,
      cwd: options.cwd,
      args: options.args,
      inputMode: options.inputMode,
      stopSignal: options.stopSignal,
      logFile: options.logFile
    },
    'PTY process started'
  );

  ptyProcess.onData(async (chunk) => {
    observedAnsi = observedAnsi || ANSI_PATTERN.test(chunk);
    process.stdout.write(chunk);
    const lines = lineBuffer.push(chunk);
    await logWriter.writeLines(lines);
  });

  ptyProcess.onExit(async ({ exitCode, signal }) => {
    const pending = lineBuffer.flush();
    await logWriter.writeLines(pending);
    printSummary({
      pid: ptyProcess.pid,
      exitCode,
      signal,
      observedAnsi,
      recommendedInputMode: options.inputMode,
      recommendedStopSignal: options.stopSignal,
      logFile: options.logFile
    });
    process.exit(0);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'pty-smoke> '
  });

  const lineEnding = toLineEnding(options.inputMode);

  const quit = async () => {
    printSummary({
      pid: ptyProcess.pid,
      observedAnsi,
      recommendedInputMode: options.inputMode,
      recommendedStopSignal: options.stopSignal,
      logFile: options.logFile
    });
    rl.close();
    process.exit(0);
  };

  const handleSignalCommand = (value: string) => {
    process.kill(ptyProcess.pid, value as NodeJS.Signals);
    logger.info({ pid: ptyProcess.pid, signal: value }, 'Signal sent');
  };

  const handleResizeCommand = (colsText: string, rowsText: string) => {
    const cols = Number(colsText);
    const rows = Number(rowsText);
    ptyProcess.resize(cols, rows);
    logger.info({ cols, rows }, 'PTY resized');
  };

  const handleMetaCommand = async (line: string) => {
    if (line === '/quit') {
      await quit();
      return;
    }

    if (line.startsWith('/raw ')) {
      ptyProcess.write(line.slice(5));
      return;
    }

    if (line.startsWith('/signal ')) {
      handleSignalCommand(line.slice(8).trim());
      return;
    }

    if (line.startsWith('/resize ')) {
      const [, cols, rows] = line.split(/\s+/);
      handleResizeCommand(cols, rows);
      return;
    }

    logger.warn({ line }, 'Unknown meta command');
  };

  logger.info({ helpText }, 'Smoke runner ready');
  rl.prompt();

  rl.on('line', async (line) => {
    if (line.startsWith('/')) {
      await handleMetaCommand(line.trim());
      rl.prompt();
      return;
    }

    ptyProcess.write(`${line}${lineEnding}`);
    rl.prompt();
  });

  process.on('SIGINT', async () => {
    logger.info({ signal: options.stopSignal }, 'Runner received SIGINT, forwarding preferred stop signal');
    process.kill(ptyProcess.pid, options.stopSignal);
    setTimeout(() => {
      try {
        process.kill(ptyProcess.pid, 'SIGKILL');
      } catch {
        logger.info('PTY process already exited before force kill');
      }
    }, options.stopTimeoutMs);
  });
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  if (message === helpText) {
    process.stdout.write(`${helpText}\n`);
    process.exit(0);
  }

  logger.error({ err: error }, 'Smoke runner failed');
  process.exit(1);
});
