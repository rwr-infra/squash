import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

// A line index over a text file that only grows — until it is replaced or
// truncated (rwr_server empties rwr_server.log whenever it starts). It records
// the byte offset of every STRIDE-th line, so any line range is one seek plus
// a short scan away, and catches up on appended bytes incrementally. Nothing
// but those offsets stays in memory, whatever the file's size.
//
// Lines end at "\n"; a trailing "\r" is dropped, and bytes after the last
// "\n" form one more (partial) line. Text is decoded as UTF-8, invalid
// sequences replaced. Splitting on the "\n" byte is safe in UTF-8: it never
// occurs inside a multi-byte sequence.
//
// A rewrite is recognized by a new file (device/inode), a shorter file, or
// changed bytes in the first or last FINGERPRINT_BYTES of the indexed part.
// A same-length rewrite that changes only bytes between those goes unnoticed;
// a log is appended to or started over, not edited in place.

export type LineIndexSnapshot = {
  readonly exists: boolean;
  // Bytes and lines the index covers (the file as of the last refresh). An
  // append can complete a partial last line without adding one: whoever
  // keeps lines must read the last one again when `size` grows.
  readonly size: number;
  readonly lineCount: number;
  // Changes whenever the index had to start over: the file was replaced,
  // truncated, rewritten, or appeared/disappeared. Line numbers and search
  // results from another generation describe other content.
  readonly generation: string;
  readonly modifiedAt?: string;
};

export type LineRange = {
  readonly snapshot: LineIndexSnapshot;
  readonly from: number;
  readonly lines: readonly string[];
};

export type SearchOptions = {
  readonly caseSensitive: boolean;
  readonly limit: number;
  readonly signal?: AbortSignal;
};

export type SearchResult = {
  readonly snapshot: LineIndexSnapshot;
  // 0-based numbers of the matching lines, ascending; each line once.
  readonly matches: readonly number[];
  // Stopped at `limit` with more to come.
  readonly truncated: boolean;
};

export type LineIndex = {
  // Brings the index up to date with the file. Concurrent calls share one run.
  refresh: () => Promise<LineIndexSnapshot>;
  // Lines [from, from + count) of the indexed content, clipped to it (at most
  // MAX_READ_LINES). Throws StaleIndexError when the file no longer holds
  // what was indexed: refresh, then read again.
  readLines: (from: number, count: number) => Promise<LineRange>;
  // Lines of the indexed content containing `query`. A match cannot span
  // lines, so a query with a line break matches nothing. Throws
  // StaleIndexError like readLines, also when the file changed mid-search.
  search: (query: string, options: SearchOptions) => Promise<SearchResult>;
};

export type LineIndexOptions = {
  // Lines between recorded offsets.
  readonly stride?: number;
  // A longer line is cut to this many bytes in readLines (marked at the end).
  readonly maxLineBytes?: number;
  readonly chunkBytes?: number;
};

// The file no longer starts with the indexed bytes.
export class StaleIndexError extends Error {
  constructor(filePath: string) {
    super(`${filePath} changed while it was read`);
    this.name = 'StaleIndexError';
  }
}

export const MAX_READ_LINES = 10_000;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
// Bytes compared at each end of the indexed content to tell an append from a
// rewrite that happens to leave the file at least as long as before.
const FINGERPRINT_BYTES = 4096;
// A partial line longer than this is searched in pieces (overlapping by the
// query's length, so no match is lost) rather than buffered whole.
const MAX_SEARCH_CARRY_BYTES = 4 * 1024 * 1024;
// Non-blocking where it exists: opening a FIFO in place of the log would
// otherwise hang until someone writes to it.
const OPEN_FLAGS = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK;

type State = {
  readonly generation: string;
  readonly exists: boolean;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeMs: number;
  // Indexed bytes.
  readonly size: number;
  // "\n" bytes within them.
  readonly newlines: number;
  // checkpoints[k] is the byte offset where line k * stride starts.
  readonly checkpoints: readonly number[];
  readonly head: Buffer;
  readonly tail: Buffer;
};

type Opened = {
  readonly handle: FileHandle;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  readonly mtimeMs: number;
};

const emptyState = (exists: boolean, dev = 0n, ino = 0n): State => ({
  generation: randomUUID(),
  exists,
  dev,
  ino,
  mtimeMs: 0,
  size: 0,
  newlines: 0,
  checkpoints: [0],
  head: Buffer.alloc(0),
  tail: Buffer.alloc(0)
});

// Bytes after the last "\n" are one more line. (The tail fingerprint ends
// with the last indexed byte.)
const lineCountOf = (state: State): number =>
  state.size === 0 ? 0 : state.newlines + (state.tail[state.tail.length - 1] === NEWLINE ? 0 : 1);

const snapshotOf = (state: State): LineIndexSnapshot => ({
  exists: state.exists,
  size: state.size,
  lineCount: lineCountOf(state),
  generation: state.generation,
  ...(state.exists && state.mtimeMs > 0 ? { modifiedAt: new Date(state.mtimeMs).toISOString() } : {})
});

const readExactly = async (handle: FileHandle, position: number, length: number): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
};

const isMissing = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

// Length of the longest prefix of `bytes` that does not end inside a UTF-8
// sequence (so a cut line does not end in a replacement character).
const wholeUtf8Length = (bytes: Buffer): number => {
  let start = bytes.length - 1;
  while (start >= 0 && start > bytes.length - 4 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  if (start < 0) return bytes.length;
  const lead = bytes[start]!;
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return start + needed <= bytes.length ? bytes.length : start;
};

// Case folding for case-insensitive search: lower case, and the Greek final
// sigma (which toLowerCase picks by position in a word) as the plain one.
const fold = (text: string) => text.toLowerCase().replace(/ς/g, 'σ');

const abortError = () => Object.assign(new Error('Search aborted'), { name: 'AbortError' });

// Opens the file for reading, or undefined when it is missing. Anything but
// a regular file (a directory, a FIFO) is an error.
const openLog = async (filePath: string): Promise<Opened | undefined> => {
  let handle: FileHandle;
  try {
    handle = await open(filePath, OPEN_FLAGS);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) {
      throw Object.assign(new Error(`${filePath} is not a regular file`), { code: 'ENOTFILE' });
    }
    return { handle, dev: info.dev, ino: info.ino, size: Number(info.size), mtimeMs: Number(info.mtimeMs) };
  } catch (err) {
    await handle.close();
    throw err;
  }
};

// Whether the file still holds `state`'s bytes at both ends of the indexed
// part (a truncated file reads short and fails too).
const sameBytes = async (handle: FileHandle, state: State): Promise<boolean> => {
  if (state.size === 0) return true;
  const head = await readExactly(handle, 0, state.head.length);
  const tail = await readExactly(handle, state.size - state.tail.length, state.tail.length);
  return head.equals(state.head) && tail.equals(state.tail);
};

// Whether the indexed bytes are still the start of the opened file.
const holdsPrefix = async (opened: Opened, state: State): Promise<boolean> =>
  opened.dev === state.dev && opened.ino === state.ino && opened.size >= state.size && (await sameBytes(opened.handle, state));

export const createLineIndex = (filePath: string, options: LineIndexOptions = {}): LineIndex => {
  const stride = options.stride ?? 1024;
  const maxLineBytes = options.maxLineBytes ?? 16 * 1024;
  const chunkBytes = options.chunkBytes ?? 1024 * 1024;

  let state = emptyState(false);
  let refreshing: Promise<LineIndexSnapshot> | undefined;

  // Scans [from.size, size) of the file and returns the extended state.
  const extend = async (handle: FileHandle, from: State, size: number, mtimeMs: number): Promise<State> => {
    let newlines = from.newlines;
    const checkpoints = [...from.checkpoints];
    let position = from.size;
    let last: Buffer = Buffer.alloc(0);
    while (position < size) {
      const chunk = await readExactly(handle, position, Math.min(chunkBytes, size - position));
      if (chunk.length === 0) break; // Shrank while we read; the next refresh starts over.
      let at = chunk.indexOf(NEWLINE);
      while (at !== -1) {
        newlines += 1;
        if (newlines % stride === 0) checkpoints.push(position + at + 1);
        at = chunk.indexOf(NEWLINE, at + 1);
      }
      position += chunk.length;
      last = chunk;
    }
    const tailLength = Math.min(FINGERPRINT_BYTES, position);
    const tail = last.length >= tailLength
      ? Buffer.from(last.subarray(last.length - tailLength))
      : await readExactly(handle, position - tailLength, tailLength);
    const head = from.head.length >= Math.min(FINGERPRINT_BYTES, position)
      ? from.head
      : await readExactly(handle, 0, Math.min(FINGERPRINT_BYTES, position));
    return { ...from, mtimeMs, size: position, newlines, checkpoints, head, tail };
  };

  const runRefresh = async (): Promise<LineIndexSnapshot> => {
    const opened = await openLog(filePath);
    if (!opened) {
      if (state.exists) state = emptyState(false);
      return snapshotOf(state);
    }
    try {
      const { handle, dev, ino, size, mtimeMs } = opened;
      let base = state;
      if (!base.exists || !(await holdsPrefix(opened, base))) {
        base = emptyState(true, dev, ino);
      } else if (size === base.size) {
        state = { ...base, mtimeMs };
        return snapshotOf(state);
      }
      let next = await extend(handle, base, size, mtimeMs);
      // Emptied and regrown while we read the new bytes: start over.
      if (base.size > 0 && !(await sameBytes(handle, base))) {
        next = await extend(handle, emptyState(true, dev, ino), size, mtimeMs);
      }
      state = next;
      return snapshotOf(state);
    } finally {
      await opened.handle.close();
    }
  };

  const refresh = () => {
    refreshing ??= runRefresh().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  // Opens the file for reading `current`, checked to still hold it; undefined
  // when nothing was indexed.
  const openIndexed = async (current: State): Promise<FileHandle | undefined> => {
    if (!current.exists) return undefined;
    const opened = await openLog(filePath);
    if (!opened) throw new StaleIndexError(filePath);
    if (!(await holdsPrefix(opened, current))) {
      await opened.handle.close();
      throw new StaleIndexError(filePath);
    }
    return opened.handle;
  };

  // Rechecks after a read, which may have raced a rewrite.
  const confirmUnchanged = async (handle: FileHandle, current: State) => {
    if (!(await sameBytes(handle, current))) throw new StaleIndexError(filePath);
  };

  const readLines = async (from: number, count: number): Promise<LineRange> => {
    const current = state;
    const snapshot = snapshotOf(current);
    const first = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
    const wanted = Number.isFinite(count) ? Math.min(MAX_READ_LINES, Math.max(0, Math.floor(count))) : 0;
    const start = Math.min(first, snapshot.lineCount);
    const end = Math.min(snapshot.lineCount, start + wanted);
    if (start >= end) return { snapshot, from: start, lines: [] };
    const handle = await openIndexed(current);
    if (!handle) return { snapshot, from: start, lines: [] };
    try {
      // The nearest recorded line at or before `start`.
      const checkpoint = Math.min(Math.floor(start / stride), current.checkpoints.length - 1);
      let line = checkpoint * stride;
      let position = current.checkpoints[checkpoint]!;
      const lines: string[] = [];
      // The line being collected: its first maxLineBytes bytes, and how many
      // more there were.
      let pieces: Buffer[] = [];
      let kept = 0;
      let dropped = 0;
      let lastByte = -1;
      const finishLine = () => {
        if (line >= start) {
          let bytes = Buffer.concat(pieces, kept);
          // A "\r" before the "\n" is not part of the line.
          if (lastByte === CARRIAGE_RETURN) {
            if (dropped > 0) dropped -= 1;
            else bytes = bytes.subarray(0, bytes.length - 1);
          }
          if (dropped > 0) {
            const whole = wholeUtf8Length(bytes);
            dropped += bytes.length - whole;
            bytes = bytes.subarray(0, whole);
          }
          const text = bytes.toString('utf8');
          lines.push(dropped > 0 ? `${text} … [${dropped} more bytes]` : text);
        }
        line += 1;
        pieces = [];
        kept = 0;
        dropped = 0;
        lastByte = -1;
      };
      const take = (bytes: Buffer) => {
        if (line < start) return; // Skipped lines are only counted.
        if (bytes.length > 0) lastByte = bytes[bytes.length - 1]!;
        const room = maxLineBytes - kept;
        if (bytes.length <= room) {
          pieces.push(bytes);
          kept += bytes.length;
        } else {
          if (room > 0) pieces.push(bytes.subarray(0, room));
          kept += Math.max(0, room);
          dropped += bytes.length - Math.max(0, room);
        }
      };
      while (position < current.size && line < end) {
        const chunk = await readExactly(handle, position, Math.min(chunkBytes, current.size - position));
        if (chunk.length === 0) break;
        let lineStart = 0;
        let at = chunk.indexOf(NEWLINE);
        while (at !== -1 && line < end) {
          take(chunk.subarray(lineStart, at));
          finishLine();
          lineStart = at + 1;
          at = chunk.indexOf(NEWLINE, lineStart);
        }
        if (line < end) take(chunk.subarray(lineStart));
        position += chunk.length;
      }
      // The partial last line (no "\n" after it).
      if (line < end && line === snapshot.lineCount - 1) finishLine();
      await confirmUnchanged(handle, current);
      return { snapshot, from: start, lines };
    } finally {
      await handle.close();
    }
  };

  const search = async (query: string, options: SearchOptions): Promise<SearchResult> => {
    const current = state;
    const snapshot = snapshotOf(current);
    const matches: number[] = [];
    if (query.length === 0 || /[\r\n]/.test(query) || current.size === 0) return { snapshot, matches, truncated: false };
    const needle = options.caseSensitive ? query : fold(query);
    // What an overlong line's pieces overlap by: a match across the cut
    // starts within this many bytes before it.
    const overlap = Math.max(0, Buffer.byteLength(query, 'utf8') - 1);
    const handle = await openIndexed(current);
    if (!handle) return { snapshot, matches, truncated: false };
    try {
      let line = 0;
      let lastMatch = -1;
      let carry: Buffer = Buffer.alloc(0);
      // Records the lines of `text` (which starts at line `line`) that match,
      // and moves `line` past its "\n". True once `limit` is exceeded.
      const scan = (text: string): boolean => {
        const haystack = options.caseSensitive ? text : fold(text);
        let base = line;
        let counted = 0; // "\n" before this position are counted in `base`.
        let at = haystack.indexOf(needle);
        while (at !== -1) {
          let nl = haystack.indexOf('\n', counted);
          while (nl !== -1 && nl < at) {
            base += 1;
            counted = nl + 1;
            nl = haystack.indexOf('\n', counted);
          }
          if (base !== lastMatch) {
            if (matches.length >= options.limit) return true;
            matches.push(base);
            lastMatch = base;
          }
          if (nl === -1) break;
          // The next match on a later line.
          base += 1;
          counted = nl + 1;
          at = haystack.indexOf(needle, counted);
        }
        for (let nl = haystack.indexOf('\n', counted); nl !== -1; nl = haystack.indexOf('\n', nl + 1)) base += 1;
        line = base;
        return false;
      };
      let truncated = false;
      let position = 0;
      while (position < current.size && !truncated) {
        if (options.signal?.aborted) throw abortError();
        const chunk = await readExactly(handle, position, Math.min(chunkBytes, current.size - position));
        if (chunk.length === 0) break;
        position += chunk.length;
        const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        const lastNewline = data.lastIndexOf(NEWLINE);
        if (lastNewline === -1) {
          if (data.length <= MAX_SEARCH_CARRY_BYTES) {
            carry = data;
            continue;
          }
          // An overlong line: search this piece of it now, keep its end.
          truncated = scan(data.toString('utf8'));
          carry = Buffer.from(data.subarray(Math.max(0, data.length - overlap)));
          continue;
        }
        truncated = scan(data.subarray(0, lastNewline + 1).toString('utf8'));
        carry = Buffer.from(data.subarray(lastNewline + 1));
      }
      if (!truncated && carry.length > 0) truncated = scan(carry.toString('utf8'));
      await confirmUnchanged(handle, current);
      return { snapshot, matches, truncated };
    } finally {
      await handle.close();
    }
  };

  return { refresh, readLines, search };
};
