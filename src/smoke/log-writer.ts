import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const toTimestampedLine = (line: string) => `[${new Date().toISOString()}] ${line}\n`;

export const createLogWriter = async (filePath: string) => {
  await mkdir(path.dirname(filePath), { recursive: true });

  return {
    writeLines(lines: readonly string[]) {
      if (!lines.length) {
        return Promise.resolve();
      }

      const payload = lines.map(toTimestampedLine).join('');
      return appendFile(filePath, payload, 'utf8');
    }
  };
};
