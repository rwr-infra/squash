import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { InstanceTemplate } from '../template/template-types.js';

export type TemplateStore = {
  list: () => readonly InstanceTemplate[];
  // Applies `change` to a copy of the templates, writes the copy to disk and
  // only then makes it current. Changes run one at a time, each seeing all
  // earlier ones, so a check made inside `change` (a free name) still holds
  // when its result is written. If `change` throws or the write fails, the
  // templates stay as they were. A change that alters nothing writes nothing.
  update: <T>(change: (templates: Map<string, InstanceTemplate>) => T) => Promise<T>;
};

// Written when the templates file does not exist yet — on first launch, not
// after: a list the user emptied stays empty. `./rwr_server` works on Windows
// too (the PTY adapter adds `.exe` to a relative path without an extension).
export const createDefaultTemplates = (): InstanceTemplate[] => [
  {
    id: randomUUID(),
    name: 'RWR dedicated server',
    values: {
      executable: './rwr_server',
      restartPolicy: 'always',
      restartDelayMs: 3000,
      // `quit`, then an empty line: rwr_server answers `quit` with `Exit
      // requested` and exits only on one more Enter.
      stopCommand: 'quit\n',
      stopTimeoutMs: 15000
    }
  }
];

// A shape check only: the API validates what it writes, and the UI applies
// only the known template fields.
const isTemplate = (value: unknown): value is InstanceTemplate => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, values } = value as Record<string, unknown>;
  return (
    typeof id === 'string' && id.length > 0 &&
    typeof name === 'string' &&
    typeof values === 'object' && values !== null && !Array.isArray(values)
  );
};

const unusable = (filePath: string, problem: string, cause?: unknown) =>
  new Error(`${filePath} ${problem}. Fix or delete it; squash leaves it untouched.`, { cause });

// undefined = no file yet. A file that can't be used as it is is an error,
// never an empty or trimmed list: the next write would replace the user's
// templates with it.
const readTemplatesFromDisk = async (filePath: string): Promise<InstanceTemplate[] | undefined> => {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
  let parsed: unknown;
  try {
    // Windows editors may save UTF-8 with a byte order mark.
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    throw unusable(filePath, `is not valid JSON (${(err as Error).message})`, err);
  }
  if (!Array.isArray(parsed) || !parsed.every(isTemplate)) {
    throw unusable(filePath, 'must be a JSON array of templates ({ "id", "name", "values" })');
  }
  const ids = new Set(parsed.map(template => template.id));
  if (ids.size !== parsed.length) {
    throw unusable(filePath, 'lists the same template id more than once');
  }
  return parsed;
};

export const createTemplateStore = async (filePath: string): Promise<TemplateStore> => {
  const initial = await readTemplatesFromDisk(filePath);
  let current = new Map<string, InstanceTemplate>((initial ?? createDefaultTemplates()).map(template => [template.id, template]));

  // Write a temp file and rename it over the real one: a write cut short
  // (squash killed, power lost) must not leave a truncated templates.json,
  // which would stop squash from starting.
  const write = async (templates: ReadonlyMap<string, InstanceTemplate>) => {
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(Array.from(templates.values()), null, 2), 'utf8');
    await rename(tempPath, filePath);
  };

  if (!initial) {
    await write(current);
  }

  let queue: Promise<unknown> = Promise.resolve();

  return {
    list() {
      return Array.from(current.values());
    },
    update(change) {
      const run = queue.then(async () => {
        const next = new Map(current);
        const result = change(next);
        const changed = next.size !== current.size || Array.from(next).some(([id, template]) => current.get(id) !== template);
        if (changed) {
          await write(next);
          current = next;
        }
        return result;
      });
      queue = run.catch(() => {});
      return run;
    }
  };
};
