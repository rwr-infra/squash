import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';

/**
 * A fresh directory under the OS temp dir for the current file or suite:
 * created in beforeAll, removed in afterAll — after the hooks registered later
 * (a server closing, say), as afterAll hooks run in reverse. Never created
 * while tests are collected: when a filter (-t) skips every test, Vitest runs
 * neither hook, and a directory made earlier would be left behind.
 * Call the returned function from hooks and tests only.
 */
export const useTempDir = (prefix: string): (() => string) => {
  let dir: string | undefined;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  });
  afterAll(() => {
    // Retried: on Windows a child that has just exited can hold its cwd briefly.
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });
  return () => {
    if (!dir) throw new Error(`${prefix} temp dir used outside a hook or test`);
    return dir;
  };
};
