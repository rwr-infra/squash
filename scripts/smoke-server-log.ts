// Smoke for the rwr_server.log viewer's line index (and, from B2 on, its
// routes). Every check compares against a ground truth computed from the
// same bytes in memory. Checks:
//   - line count and random line ranges match, for LF and CRLF lines, empty
//     lines, multi-byte characters across read-chunk boundaries, lines over
//     the length cap (cut and marked, never inside a character), and a last
//     line without "\n" — with a tiny stride/chunk size and with the defaults
//   - appends (including completing a partial last line) extend the index
//     under the same generation
//   - truncation, truncation followed by regrowth past the old size (also
//     with the first 4 KiB unchanged, as when every run starts with the same
//     banner), a same-length rewrite of the first and last bytes, replacement
//     by a new file (also one that starts with the old content), deletion and
//     re-creation each start a new generation with correct content
//   - reading or searching a file rewritten since the last refresh throws
//     StaleIndexError instead of returning new content under the old
//     generation
//   - search: case-insensitive and -sensitive line matches equal the truth,
//     a line matching twice counts once (also across the pieces of a line
//     over 4 MiB, and a match across a piece boundary is found), non-ASCII
//     queries and the Greek final sigma, a query with a line break matches
//     nothing, the limit and its `truncated` flag (not set at exactly the
//     limit), an aborted search rejects — before and during the scan
//   - invalid UTF-8 is replaced without disturbing line numbers; odd
//     readLines arguments are clamped; a directory or FIFO in place of the
//     log is an error, not a hang
//   - concurrent refreshes share one run
//   - a 1M-line file: index build time, a read at the end, a full search, and
//     the longest event-loop stall while indexing
// Uses a temp directory only.
//
// Usage: npm run smoke:server-log

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { createLineIndex, MAX_READ_LINES, StaleIndexError } from '../src/core/log/line-index.js';
import type { LineIndex } from '../src/core/log/line-index.js';

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
};

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-server-log-smoke-'));
process.on('exit', () => fs.rmSync(workRoot, { recursive: true, force: true }));

// Deterministic pseudo-random numbers, so a failure reproduces.
let seed = 42;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const MAX_LINE_BYTES = 200;
const WORDS = ['player', 'Joined', 'kill', 'é', '中文', 'καλη', '🙂', 'ERROR', 'error', 'quit', 'x'.repeat(30)];

const makeLine = (i: number): string => {
  if (random() < 0.05) return '';
  // Over MAX_LINE_BYTES, in 2-, 3- and 4-byte characters (cut points vary).
  if (random() < 0.03) return `long ${i} ${pick(['é', '中', '🙂'])!.repeat(70 + Math.floor(random() * 60))}`;
  return `${i} ${Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(WORDS)).join(' ')}`;
};

// The file's text from its lines: random LF/CRLF endings, and optionally no
// "\n" after the last line.
const render = (lines: readonly string[], trailingNewline: boolean) =>
  lines.map((line, i) => (i < lines.length - 1 || trailingNewline ? `${line}${random() < 0.3 ? '\r\n' : '\n'}` : line)).join('');

// What the index should report for `text`.
const truth = (text: string): string[] => {
  if (text.length === 0) return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((part) => (part.endsWith('\r') ? part.slice(0, -1) : part));
};

// A line over the cap: its first MAX_LINE_BYTES bytes, minus a character cut
// in half (a streaming decoder holds those bytes back), and how many more.
const expectedLine = (line: string): string => {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= MAX_LINE_BYTES) return line;
  const kept = new TextDecoder().decode(bytes.subarray(0, MAX_LINE_BYTES), { stream: true });
  return `${kept} … [${bytes.length - Buffer.byteLength(kept)} more bytes]`;
};

const sameLines = async (index: LineIndex, expected: readonly string[], label: string, samples = 40) => {
  const snapshot = await index.refresh();
  if (!check(`${label}: line count`, snapshot.lineCount === expected.length, `${snapshot.lineCount} vs ${expected.length}`)) return;
  const ranges: Array<[number, number]> = [[0, 50], [Math.max(0, expected.length - 50), 60], [expected.length, 5]];
  for (let i = 0; i < samples; i++) {
    ranges.push([Math.floor(random() * expected.length), 1 + Math.floor(random() * 120)]);
  }
  let bad = '';
  for (const [from, count] of ranges) {
    const range = await index.readLines(from, count);
    const want = expected.slice(from, from + count).map(expectedLine);
    if (range.from !== Math.min(from, expected.length) || JSON.stringify(range.lines) !== JSON.stringify(want)) {
      const at = want.findIndex((line, i) => range.lines[i] !== line);
      bad = `from ${from} count ${count} (got ${range.lines.length} lines from ${range.from}): line ${from + at} is ${JSON.stringify(range.lines[at])}, want ${JSON.stringify(want[at])}`;
      break;
    }
  }
  check(`${label}: random ranges`, bad === '', bad);
};

const searchTruth = (lines: readonly string[], query: string, caseSensitive: boolean) =>
  lines.flatMap((line, i) => ((caseSensitive ? line : line.toLowerCase()).includes(caseSensitive ? query : query.toLowerCase()) ? [i] : []));

const checkSearches = async (index: LineIndex, lines: readonly string[], label: string) => {
  await index.refresh();
  for (const [query, caseSensitive] of [['error', false], ['ERROR', true], ['中文', false], ['é', true], ['kill joined', false], ['🙂', false]] as const) {
    const result = await index.search(query, { caseSensitive, limit: 1_000_000 });
    const want = searchTruth(lines, query, caseSensitive);
    check(
      `${label}: search ${JSON.stringify(query)}${caseSensitive ? ' (case-sensitive)' : ''}`,
      !result.truncated && JSON.stringify(result.matches) === JSON.stringify(want),
      `${result.matches.length} vs ${want.length}`
    );
  }
  const limited = await index.search('error', { caseSensitive: false, limit: 3 });
  const all = searchTruth(lines, 'error', false);
  check(`${label}: search limit`, limited.truncated === all.length > 3 && JSON.stringify(limited.matches) === JSON.stringify(all.slice(0, 3)));
};

const checkCorrectness = async (options: { stride?: number; chunkBytes?: number }, label: string) => {
  const file = path.join(workRoot, `${label.replace(/\W+/g, '-')}.log`);
  let lines = Array.from({ length: 3000 }, (_, i) => makeLine(i));
  // A line that will be completed by the append below.
  let text = render(lines, false);
  fs.writeFileSync(file, text);
  const index = createLineIndex(file, { maxLineBytes: MAX_LINE_BYTES, ...options });
  await sameLines(index, truth(text), `${label} initial`);
  const generation = (await index.refresh()).generation;
  await checkSearches(index, truth(text), `${label} initial`);

  // Append: completes the partial last line, then adds more.
  const appended = `-completed\n${render(Array.from({ length: 500 }, (_, i) => makeLine(3000 + i)), true)}`;
  fs.appendFileSync(file, appended);
  text += appended;
  await sameLines(index, truth(text), `${label} after append`);
  check(`${label}: an append keeps the generation`, (await index.refresh()).generation === generation);

  // Truncated to nothing, then a short new run.
  fs.writeFileSync(file, '');
  const empty = await index.refresh();
  check(`${label}: truncation to empty starts a new generation`, empty.generation !== generation && empty.lineCount === 0 && empty.exists);
  lines = Array.from({ length: 200 }, (_, i) => `run2 ${makeLine(i)}`);
  text = render(lines, true);
  fs.appendFileSync(file, text);
  await sameLines(index, truth(text), `${label} second run`);
  const second = (await index.refresh()).generation;
  check(`${label}: the second run keeps its generation`, second === empty.generation);

  // Truncated and rewritten past the old size before the next refresh.
  const before = fs.statSync(file).size;
  lines = Array.from({ length: 900 }, (_, i) => `run3 ${makeLine(i)}`);
  text = render(lines, true);
  fs.writeFileSync(file, text);
  check(`${label}: (setup) the rewrite is longer`, fs.statSync(file).size > before);
  await sameLines(index, truth(text), `${label} rewritten longer`);
  const third = (await index.refresh()).generation;
  check(`${label}: a rewrite longer than before starts a new generation`, third !== second);

  // In place, same length, different bytes.
  const flipped = text.replace(/run3/g, 'RUN3');
  fs.writeFileSync(file, flipped);
  text = flipped;
  await sameLines(index, truth(text), `${label} same-length rewrite`, 5);
  const fourth = (await index.refresh()).generation;
  check(`${label}: a same-length rewrite starts a new generation`, fourth !== third);

  // Emptied and regrown past the old size with the same first 4 KiB (a
  // fixed start-up banner): only the tail tells.
  const banner = Array.from({ length: 200 }, (_, i) => `Loading resource pack ${i}`).join('\n') + '\n';
  text = `${banner}run4 a\nrun4 b\n`;
  fs.writeFileSync(file, text);
  await sameLines(index, truth(text), `${label} banner run`, 5);
  const bannerRun = (await index.refresh()).generation;
  text = `${banner}second run with longer lines here\nzzz\nmore\n`;
  fs.writeFileSync(file, text);
  await sameLines(index, truth(text), `${label} banner rerun`, 5);
  check(`${label}: a rerun behind the same banner starts a new generation`, (await index.refresh()).generation !== bannerRun);
  const fourthAndAHalf = (await index.refresh()).generation;

  // Rewritten longer with only the start changed (same length): only the
  // head tells. (Over 8 KiB, so the head and tail fingerprints don't overlap.)
  const body = Array.from({ length: 600 }, (_, i) => `steady output line ${i}`).join('\n') + '\n';
  text = `run6 header\n${body}`;
  fs.writeFileSync(file, text);
  await sameLines(index, truth(text), `${label} header run`, 5);
  const headerRun = (await index.refresh()).generation;
  text = `RUN7 header\n${body}extra line\n`;
  fs.writeFileSync(file, text);
  await sameLines(index, truth(text), `${label} new header`, 5);
  check(`${label}: a new start with the same end starts a new generation`, (await index.refresh()).generation !== headerRun);

  // Replaced by a new file that starts with the old content: only the
  // file's identity tells.
  fs.writeFileSync(`${file}.new`, `${text}appended in a new file\n`);
  fs.renameSync(`${file}.new`, file);
  text += 'appended in a new file\n';
  await sameLines(index, truth(text), `${label} replaced, same start`, 5);
  check(`${label}: a new file with the old content as its start is a new generation`, (await index.refresh()).generation !== fourthAndAHalf);
  const renamedGeneration = (await index.refresh()).generation;

  // Replaced by a new file (rename over).
  lines = Array.from({ length: 300 }, (_, i) => `run5 ${makeLine(i)}`);
  text = render(lines, false);
  fs.writeFileSync(`${file}.new`, text);
  fs.renameSync(`${file}.new`, file);
  await sameLines(index, truth(text), `${label} replaced`, 5);
  const fifth = (await index.refresh()).generation;
  check(`${label}: replacement starts a new generation`, fifth !== fourth && fifth !== renamedGeneration);

  // Deleted, then created again.
  fs.rmSync(file);
  const gone = await index.refresh();
  check(`${label}: a deleted file reports exists=false and no lines`, !gone.exists && gone.lineCount === 0 && gone.generation !== fifth);
  const noLines = await index.readLines(0, 10);
  check(`${label}: reading a deleted file gives no lines`, noLines.lines.length === 0);
  fs.writeFileSync(file, 'back\n');
  const back = await index.refresh();
  check(`${label}: re-created file is indexed under a new generation`, back.exists && back.lineCount === 1 && back.generation !== gone.generation);
};

const checkMisc = async () => {
  const file = path.join(workRoot, 'misc.log');
  fs.writeFileSync(file, 'one error ERROR error\nTwo\r\n\r\nlast error');
  const index = createLineIndex(file, { stride: 2, chunkBytes: 5 });
  const snapshot = await index.refresh();
  check('misc: CRLF, empty line and partial last line count', snapshot.lineCount === 4, `${snapshot.lineCount}`);
  const range = await index.readLines(0, 10);
  check('misc: lines read back', JSON.stringify(range.lines) === JSON.stringify(['one error ERROR error', 'Two', '', 'last error']), JSON.stringify(range.lines));
  const hits = await index.search('error', { caseSensitive: false, limit: 100 });
  check('misc: a line matching several times counts once', JSON.stringify(hits.matches) === '[0,3]', JSON.stringify(hits.matches));
  const controller = new AbortController();
  controller.abort();
  const aborted = await index.search('error', { caseSensitive: false, limit: 100, signal: controller.signal }).then(() => undefined, (err: Error) => err);
  check('misc: an aborted search rejects with AbortError', aborted?.name === 'AbortError', aborted?.message ?? 'resolved');
  const missing = createLineIndex(path.join(workRoot, 'no-such-dir', 'rwr_server.log'));
  const none = await missing.refresh();
  check('misc: a missing file (and directory) is exists=false', !none.exists && none.lineCount === 0 && none.size === 0);

  const shared = createLineIndex(file);
  const [a, b] = await Promise.all([shared.refresh(), shared.refresh()]);
  check('misc: concurrent refreshes share one run', a === b);

  // Exactly `limit` matches is not truncated; one more is.
  fs.writeFileSync(file, 'hit 1\nmiss\nhit 2\nhit 3\n');
  await index.refresh();
  const exact = await index.search('hit', { caseSensitive: true, limit: 3 });
  const over = await index.search('hit', { caseSensitive: true, limit: 2 });
  check('misc: exactly `limit` matches is not truncated', exact.matches.length === 3 && !exact.truncated);
  check('misc: more than `limit` matches is truncated', JSON.stringify(over.matches) === '[0,2]' && over.truncated);
  check('misc: a query with a line break matches nothing', (await index.search('1\nmiss', { caseSensitive: true, limit: 10 })).matches.length === 0);

  // The final sigma: "ΚΑΛΗΣ" lower-cases to "καλης", "Σ" to "σ".
  fs.writeFileSync(file, 'ΚΑΛΗΣ\nΑΣΑ\nnone\n');
  await index.refresh();
  check('misc: Σ matches a word-final Σ ignoring case', JSON.stringify((await index.search('Σ', { caseSensitive: false, limit: 10 })).matches) === '[0,1]');
  check('misc: "ης" matches "ΗΣ" ignoring case', JSON.stringify((await index.search('ης', { caseSensitive: false, limit: 10 })).matches) === '[0]');

  // Invalid UTF-8 and a partial last line ending in "\r".
  fs.writeFileSync(file, Buffer.concat([Buffer.from('ok\n'), Buffer.from([0xff, 0xfe, 0x41]), Buffer.from('\nnext\nlast\r')]));
  await index.refresh();
  const odd = await index.readLines(0, 10);
  check('misc: invalid UTF-8 is replaced, lines keep their numbers', JSON.stringify(odd.lines) === JSON.stringify(['ok', '\uFFFD\uFFFDA', 'next', 'last']), JSON.stringify(odd.lines));
  check('misc: search past invalid UTF-8 keeps line numbers', JSON.stringify((await index.search('next', { caseSensitive: true, limit: 10 })).matches) === '[2]');

  // Odd readLines arguments are clamped, not trusted.
  const fractional = await index.readLines(1.5, 2);
  const notANumber = await index.readLines(Number.NaN, 2);
  const huge = await index.readLines(0, Number.POSITIVE_INFINITY);
  check('misc: readLines floors a fractional start', fractional.from === 1 && fractional.lines[0] === '\uFFFD\uFFFDA');
  check('misc: readLines treats NaN as 0 and an infinite count as none', notANumber.from === 0 && notANumber.lines.length === 2 && huge.lines.length === 0);
  check('misc: readLines caps a range', MAX_READ_LINES === 10_000);

  // Rewritten since the last refresh: reading or searching refuses.
  const staleFile = path.join(workRoot, 'stale.log');
  fs.writeFileSync(staleFile, Array.from({ length: 100 }, (_, i) => `old line ${i}`).join('\n') + '\n');
  const stale = createLineIndex(staleFile, { stride: 8 });
  const before = await stale.refresh();
  fs.writeFileSync(staleFile, Array.from({ length: 300 }, (_, i) => `NEW-RUN entry number ${i}`).join('\n') + '\n');
  const staleRead = await stale.readLines(40, 3).then(() => undefined, (err: Error) => err);
  const staleSearch = await stale.search('NEW-RUN', { caseSensitive: true, limit: 10 }).then(() => undefined, (err: Error) => err);
  check('misc: reading a file rewritten since the refresh throws StaleIndexError', staleRead instanceof StaleIndexError, staleRead?.message ?? 'returned lines');
  check('misc: searching it throws StaleIndexError', staleSearch instanceof StaleIndexError, staleSearch?.message ?? 'returned matches');
  const after = await stale.refresh();
  const fresh = await stale.readLines(40, 1);
  check('misc: after a refresh the new content reads under a new generation', after.generation !== before.generation && fresh.lines[0] === 'NEW-RUN entry number 40');

  // Aborted while scanning (not only before): a signal that turns aborted
  // on its fourth look.
  const slow = createLineIndex(staleFile, { chunkBytes: 16 });
  await slow.refresh();
  let looks = 0;
  const midScan = { get aborted() { looks += 1; return looks > 3; } } as AbortSignal;
  const midway = await slow.search('entry', { caseSensitive: true, limit: 100_000, signal: midScan }).then(() => undefined, (err: Error) => err);
  check('misc: a search aborted mid-scan rejects with AbortError', midway?.name === 'AbortError', midway?.message ?? 'resolved');

  // Not a regular file: an error, not a hang.
  const dirLog = path.join(workRoot, 'dir-log');
  fs.mkdirSync(dirLog);
  const dirError = await createLineIndex(dirLog).refresh().then(() => undefined, (err: NodeJS.ErrnoException) => err);
  check('misc: a directory in place of the log is an error', !!dirError?.code, dirError?.message ?? 'resolved');
  if (process.platform !== 'win32') {
    const fifo = path.join(workRoot, 'fifo.log');
    execFileSync('mkfifo', [fifo]);
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000));
    const fifoResult = await Promise.race([createLineIndex(fifo).refresh().then(() => 'resolved', (err: NodeJS.ErrnoException) => err.code ?? 'error'), timeout]);
    check('misc: a FIFO in place of the log is an error, not a hang', fifoResult === 'ENOTFILE', fifoResult);
  }
};

const checkOverlongLine = async () => {
  const file = path.join(workRoot, 'overlong.log');
  const mib = 1024 * 1024;
  // Line 0: a match across the first piece boundary (from the file's start,
  // pieces are cut at 5 MiB: 4 MiB of carry plus a 1 MiB chunk); line 1: two
  // matches over 5 MiB apart, in different pieces; line 2: short.
  const line0 = `${'a'.repeat(5 * mib - 3)}needle${'b'.repeat(10)}`;
  const line1 = `needle${'x'.repeat(5 * mib)}needle`;
  fs.writeFileSync(file, `${line0}\n${line1}\nshort needle\n`);
  const index = createLineIndex(file);
  await index.refresh();
  const found = await index.search('needle', { caseSensitive: true, limit: 100 });
  check('overlong: each matching line once, a match across a piece boundary found', JSON.stringify(found.matches) === '[0,1,2]', JSON.stringify(found.matches));
  const lines = await index.readLines(0, 3);
  check('overlong: the long lines are cut', lines.lines[0]!.endsWith(`more bytes]`) && lines.lines[2] === 'short needle');
};

const checkLarge = async () => {
  const file = path.join(workRoot, 'large.log');
  const lineCount = 1_000_000;
  const stream = fs.createWriteStream(file);
  for (let i = 0; i < lineCount; i++) {
    stream.write(`${new Date(1_700_000_000_000 + i * 1000).toISOString()} [info] player_${i % 997} did thing ${i}${i % 50_000 === 0 ? ' NEEDLE' : ''}\n`);
  }
  await new Promise((resolve) => stream.end(resolve));
  const size = fs.statSync(file).size;

  let maxLag = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 10);
    last = now;
  }, 10);
  const index = createLineIndex(file);
  const started = performance.now();
  const snapshot = await index.refresh();
  const buildMs = performance.now() - started;
  clearInterval(timer);
  check('large: line count', snapshot.lineCount === lineCount, `${snapshot.lineCount}`);
  console.log(`[smoke] info large: ${(size / 1e6).toFixed(0)} MB indexed in ${buildMs.toFixed(0)} ms; longest event-loop stall ${maxLag.toFixed(0)} ms`);
  check('large: indexing never stalls the event loop for 200 ms', maxLag < 200, `${maxLag.toFixed(0)} ms`);

  const readStarted = performance.now();
  const end = await index.readLines(lineCount - 100, 100);
  const readMs = performance.now() - readStarted;
  check('large: the last 100 lines', end.lines.length === 100 && end.lines[99]!.endsWith(`did thing ${lineCount - 1}`) && end.lines[0]!.endsWith(`did thing ${lineCount - 100}`));
  check('large: reading at the end is fast (< 100 ms)', readMs < 100, `${readMs.toFixed(1)} ms`);
  const mid = await index.readLines(512_345, 3);
  check('large: a range in the middle', mid.lines[0]!.endsWith('did thing 512345') && mid.lines[2]!.endsWith('did thing 512347'));

  const searchStarted = performance.now();
  const found = await index.search('needle', { caseSensitive: false, limit: 10_000 });
  const searchMs = performance.now() - searchStarted;
  console.log(`[smoke] info large: full search in ${searchMs.toFixed(0)} ms`);
  check('large: search finds every NEEDLE line', JSON.stringify(found.matches) === JSON.stringify(Array.from({ length: 20 }, (_, i) => i * 50_000)), `${found.matches.length}`);

  const unchanged = performance.now();
  await index.refresh();
  check('large: refreshing an unchanged file is cheap (< 20 ms)', performance.now() - unchanged < 20);
};

await checkCorrectness({ stride: 7, chunkBytes: 13 }, 'tiny stride/chunks');
await checkCorrectness({}, 'defaults');
await checkMisc();
await checkOverlongLine();
await checkLarge();

if (failures.length > 0) {
  console.log(`[smoke] ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[smoke] all server-log checks passed');
