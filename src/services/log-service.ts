import { appPaths } from '../app/paths.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const MAX_TAIL_LINES = 2000;

const reverseReadLines = async (filePath: string, maxLines: number): Promise<string[]> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, lines.length - maxLines);
    return lines.slice(start, lines.length).filter(line => line.trim().length > 0);
  } catch {
    return [];
  }
};

export class LogService {
  async getTail(instanceId: string, lines: number = 100): Promise<string[]> {
    const limit = Math.min(Math.max(lines, 1), MAX_TAIL_LINES);
    const logPath = path.join(appPaths.logDir, `${instanceId}.log`);
    return reverseReadLines(logPath, limit);
  }

  getLogPath(instanceId: string): string {
    return path.join(appPaths.logDir, `${instanceId}.log`);
  }
}