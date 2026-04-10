import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { InstanceLogWriter } from './log-types.js';

const toTimestampedLine = (line: string) => `[${new Date().toISOString()}] ${line}\n`;

const ensureParentDir = (filePath: string) => mkdir(path.dirname(filePath), { recursive: true });

export const createInstanceLogWriter = async (filePath: string): Promise<InstanceLogWriter> => {
  await ensureParentDir(filePath);

  return {
    async writeLines(lines) {
      if (!lines.length) {
        return;
      }

      const payload = lines.map(toTimestampedLine).join('');
      await appendFile(filePath, payload, 'utf8');
    }
  };
};

export const toInstanceLogFile = (logDir: string, instanceId: string) => path.join(logDir, `${instanceId}.log`);
