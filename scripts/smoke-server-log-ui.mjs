// rwr_server.log viewer in a real browser: the production frontend against
// the compiled backend (createHttpServer, ServerLogService, the line index;
// only the instance registry is a stub) and a real 1M-line log in a temp
// directory, driven through headless Chromium. No game process or user
// config is used. Checks:
//   - the page opens following the end within 2 s; only the rows in view
//     are in the DOM; rows show the right lines and line numbers
//   - appended lines show up while following, and don't move the view once
//     the user scrolled away (follow switches off); the Follow switch keeps
//     the view put, End follows again
//   - over the browser height cap the scrollbar maps proportionally, and the
//     wheel, PageDown and Space move by lines; a sideways scroll leaves the
//     line alone; below the cap the same keys and the wheel still work
//   - a long line is cut and scrolls sideways
//   - a failed line load says so and recovers; a block read before an
//     append that arrives after the page saw the append is read again (the
//     completed last line shows)
//   - Ctrl+F / ⌘F opens the find bar; Enter / Shift+Enter / F3 step through
//     matches over the whole file with an "i / N" count ("+" past the 10,000
//     cap), marking matches and the current row; "Aa" keeps the focus in
//     the box; past the listed matches: the nearest one, a note, no wrap; a
//     far match on a long line scrolls into view sideways; new lines offer
//     "Search again"; Esc closes from anywhere in the bar and returns the
//     keyboard to the log
//   - on a phone-sized touch screen lines wrap by default (no sideways
//     scrolling); the view follows the end, keeps still while its window of
//     lines slides, and the position slider, search and Home/End reach any
//     line; the Wrap switch is remembered
//   - the file emptied and rewritten: a notice, the new content, following
//     its end; deleted: "No rwr_server.log yet"; re-created: back, without a
//     notice; unknown instance: an error
//
// Usage: npm run build:server && npm --prefix frontend run build && npm run smoke:server-log-ui

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webRoot = path.resolve(process.env.SQUASH_FORM_WEB_ROOT ?? path.join(root, 'frontend/dist'));
assert(fs.existsSync(path.join(webRoot, 'index.html')), 'Build the frontend first');
const candidates = process.platform === 'win32'
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const browserPath = process.env.SQUASH_BROWSER_PATH ?? candidates.find(candidate => fs.existsSync(candidate));
assert(browserPath && fs.existsSync(browserPath), 'Install Chromium or set SQUASH_BROWSER_PATH');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-server-log-ui-'));
const instanceDir = path.join(work, 'server');
fs.mkdirSync(instanceDir);
const logFile = path.join(instanceDir, 'rwr_server.log');
const LINES = 1_000_000;
const LONG_LINE = 10;
const lineText = i => (i === LONG_LINE ? `long ${'x'.repeat(20_000)}` : `line ${i} ${i % 7 === 0 ? 'seven' : 'other'}`);
{
  const fd = fs.openSync(logFile, 'w');
  let chunk = '';
  for (let i = 0; i < LINES; i++) {
    chunk += `${lineText(i)}\n`;
    if (chunk.length > 1_000_000) { fs.writeSync(fd, chunk); chunk = ''; }
  }
  fs.writeSync(fd, chunk);
  fs.closeSync(fd);
}
let lineCount = LINES;

// Login off (no credentials): the page needs no token. Static files from the build.
process.env.AUTH_USERNAME = '';
delete process.env.AUTH_TOKEN;
process.env.SQUASH_STATIC_DIR = webRoot;
const { createHttpServer } = await import('../dist/api/http/http-server.js');
const { ServerLogService } = await import('../dist/services/server-log-service.js');
// A second, small instance: below the height cap, native scrolling.
const smallDir = path.join(work, 'small');
fs.mkdirSync(smallDir);
fs.writeFileSync(path.join(smallDir, 'rwr_server.log'), Array.from({ length: 3000 }, (_, i) => `small ${i}`).join('\n') + '\n');
// A third, with long lines (~400 characters) that wrap on a phone.
const wideDir = path.join(work, 'wide');
fs.mkdirSync(wideDir);
const wideText = i => `wide ${i} ${'lorem ipsum dolor sit amet '.repeat(15)}${i === 1500 ? `${'z'.repeat(15000)} deep-needle` : ''}`;
fs.writeFileSync(path.join(wideDir, 'rwr_server.log'), Array.from({ length: 40000 }, (_, i) => wideText(i)).join('\n') + '\n');
const dirs = { demo: instanceDir, small: smallDir, wide: wideDir };
const registry = { getConfig: id => (dirs[id] ? { id, name: id, cwd: dirs[id], executable: 'x', args: [], env: {}, logDir: 'logs' } : undefined) };
const serverLogService = new ServerLogService(registry);
// Faults on demand: a failing line read, or one answered late (read first,
// then held back, like a slow network).
const faults = { failLines: false, holdLinesMs: 0 };
const readLines = serverLogService.readLines.bind(serverLogService);
serverLogService.readLines = async (...args) => {
  if (faults.failLines) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  const hold = faults.holdLinesMs;
  const result = await readLines(...args);
  if (hold > 0) await sleep(hold);
  return result;
};
const server = await createHttpServer({
  instanceService: {}, logService: {}, terminalService: {}, terminalGateway: {},
  auditService: { record: async () => {} },
  templateService: {},
  serverLogService
});

const checks = [];
let failed = false;
let browser;
let socket;
let browserOutput = '';
const pageErrors = [];
const waitFor = async (predicate, label, ms = 20000) => {
  const end = Date.now() + ms;
  do { const value = await predicate(); if (value) return value; await sleep(100); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
};
const check = (label, condition, detail = '') => {
  checks.push({ label, passed: Boolean(condition) });
  console.log(`[log-ui] ${condition ? 'PASS' : 'FAIL'} ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  assert(condition, label);
};
const calls = new Map();
let sequence = 0;
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { calls.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  calls.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};

// The rows in view: first/last visible line, how many rows exist, and
// whether every visible row has loaded and shows its line's text.
const view = () => evaluate(`(() => {
  const scroller = document.querySelector('.log-viewport');
  if (!scroller) return null;
  const box = scroller.getBoundingClientRect();
  const rows = Array.from(document.querySelectorAll('.log-row'));
  const visible = rows.filter(row => { const r = row.getBoundingClientRect(); return r.bottom > box.top + 1 && r.top < box.bottom - 1; });
  return {
    rows: rows.length,
    first: visible.length ? Number(visible[0].dataset.line) : -1,
    last: visible.length ? Number(visible.at(-1).dataset.line) : -1,
    texts: visible.map(row => [Number(row.dataset.line), row.querySelector('.log-text').innerText]),
    gutters: visible.map(row => [Number(row.dataset.line), row.querySelector('.log-gutter').innerText]),
    scrollLeft: scroller.scrollLeft,
    scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
    scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
    follow: document.querySelector('[aria-label="Follow new lines"]')?.getAttribute('aria-checked'),
    text: document.body.innerText.slice(0, 2000)
  };
})()`);
// Real pointer events at an element's centre (focus moves as for a user).
const clickAt = async expression => {
  const point = await evaluate(`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
  for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
};
const loaded = async label => waitFor(async () => {
  const state = await view();
  return state && state.texts.length > 0 && state.texts.every(([, text]) => text !== '…') ? state : false;
}, label);
const rowsRight = (state, expected) => state.texts.every(([line, text]) => text === expected(line) || (line === LONG_LINE && text.startsWith('long xxx') && text.endsWith('more bytes]')));
const appendLines = count => {
  fs.appendFileSync(logFile, Array.from({ length: count }, (_, i) => `${lineText(lineCount + i)}\n`).join(''));
  lineCount += count;
};

try {
  await new Promise(resolve => server.listen({ port: 0, host: '127.0.0.1' }).then(resolve));
  const base = `http://127.0.0.1:${server.server.address().port}`;
  browser = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(work, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  browser.once('error', error => { browserOutput += error.message; });
  browser.stderr.on('data', chunk => { browserOutput += chunk; });
  browser.stdout.on('data', chunk => { browserOutput += chunk; });
  const endpoint = await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(browserOutput)?.[1], 'browser debugging endpoint');
  const pages = await (await fetch(`${new URL(endpoint).origin.replace('ws:', 'http:')}/json/list`)).json();
  const page = pages.find(item => item.type === 'page');
  assert(page, 'Browser page exists');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    const call = calls.get(message.id);
    if (!call) return;
    clearTimeout(call.timer); calls.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
  };
  await command('Page.enable');
  await command('Runtime.enable');
  const opened = Date.now();
  await command('Page.navigate', { url: `${base}/server-log/demo` });

  let state = await loaded('rows at the end');
  const firstScreenMs = Date.now() - opened;
  console.log(`[log-ui] info first screen of ${LINES.toLocaleString('en-US')} lines in ${firstScreenMs} ms (index built on first open)`);
  check('the first screen shows within 2 s', firstScreenMs < 2000, `${firstScreenMs} ms`);
  check('the gutter numbers lines from 1', state.gutters.every(([line, gutter]) => gutter === String(line + 1)), JSON.stringify(state.gutters.slice(0, 2)));
  check('the header shows the line count', state.text.includes(`${LINES.toLocaleString('en-US')} lines`), state.text.slice(0, 200));
  check('it opens following the end', state.last === LINES - 1 && state.follow === 'true', JSON.stringify({ last: state.last, follow: state.follow }));
  check('only the rows in view are in the DOM', state.rows <= 120, String(state.rows));
  check('rows show their lines', rowsRight(state, lineText), JSON.stringify(state.texts.slice(0, 3)));
  check('over the height cap the scroll height is capped', state.scrollHeight <= 8_000_000 + state.clientHeight, String(state.scrollHeight));

  appendLines(3);
  state = await waitFor(async () => { const s = await view(); return s && s.last === lineCount - 1 && s.texts.at(-1)?.[1] === lineText(lineCount - 1) ? s : false; }, 'appended lines while following');
  check('appended lines show up while following', state.follow === 'true');

  // Scroll to the middle: follow switches off, the right lines load.
  await evaluate(`(() => { const s = document.querySelector('.log-viewport'); s.scrollTop = (s.scrollHeight - s.clientHeight) / 2; })()`);
  state = await loaded('middle rows');
  check('scrolling away stops following', state.follow === 'false');
  check('the scrollbar maps proportionally onto the lines', Math.abs(state.first - lineCount / 2) < lineCount * 0.01, String(state.first));
  check('rows in the middle show their lines', rowsRight(state, lineText), JSON.stringify(state.texts.slice(0, 2)));
  const before = state.first;
  appendLines(5);
  await waitFor(async () => (await view()).text.includes(`${lineCount.toLocaleString('en-US')} lines`), 'line count after append');
  state = await view();
  check('appended lines leave a scrolled-away view in place', state.first === before, `${state.first} vs ${before}`);

  // The wheel and PageDown move by lines in scaled mode.
  const box = await evaluate(`(() => { const r = document.querySelector('.log-viewport').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 18 * 10 });
  state = await waitFor(async () => { const s = await view(); return s.first !== before ? s : false; }, 'wheel moves');
  check('the wheel moves by lines over the height cap', Math.abs(state.first - (before + 10)) <= 1, `${state.first} vs ${before + 10}`);
  const beforePage = state.first;
  const rowsInView = Math.ceil(state.clientHeight / 18);
  await evaluate(`document.querySelector('.log-viewport').focus()`);
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
  state = await waitFor(async () => { const s = await view(); return s.first !== beforePage ? s : false; }, 'PageDown moves');
  check('PageDown moves a page of lines', Math.abs(state.first - (beforePage + rowsInView - 1)) <= 1, `${state.first} vs ${beforePage + rowsInView - 1}`);
  const beforeSpace = state.first;
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  state = await waitFor(async () => { const s = await view(); return s.first !== beforeSpace ? s : false; }, 'Space moves');
  check('Space moves a page of lines over the height cap', Math.abs(state.first - (beforeSpace + rowsInView - 1)) <= 1, `${state.first} vs ${beforeSpace + rowsInView - 1}`);

  // A failed line load says so, then recovers.
  faults.failLines = true;
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await waitFor(async () => (await evaluate('document.body.innerText')).includes('Could not load lines'), 'load error banner');
  // Still failing a while: the banner itself resizes the view, which loads
  // once more; recovery after that can only come from the retry timer.
  await sleep(1500);
  faults.failLines = false;
  state = await waitFor(async () => { const s = await loaded('rows after recovery'); return s.first === 0 && !s.text.includes('Could not load lines') ? s : false; }, 'recovery', 30000);
  check('a failed line load is reported, retried and recovers', rowsRight(state, lineText));

  // At the top: the long line is cut and scrolls sideways; a sideways
  // scroll leaves the line alone; a diagonal wheel scrolls both ways.
  const long = state.texts.find(([line]) => line === LONG_LINE)?.[1] ?? '';
  check('a long line is cut and marked', long.startsWith('long xxx') && /… \[\d+ more bytes\]$/.test(long), long.slice(-40));
  check('a long line scrolls sideways', state.scrollWidth > state.clientWidth, `${state.scrollWidth} vs ${state.clientWidth}`);
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 18 * 3 });
  const beforeSideways = await waitFor(async () => { const s = await view(); return s.first === 3 ? s : false; }, 'wheel to line 3');
  await evaluate(`document.querySelector('.log-viewport').scrollLeft = 300`);
  await sleep(300);
  state = await view();
  check('a sideways scroll leaves the line alone', state.first === beforeSideways.first && state.scrollLeft === 300, `${state.first} vs ${beforeSideways.first}`);
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 40, deltaY: 90 });
  state = await waitFor(async () => { const s = await view(); return s.first !== beforeSideways.first ? s : false; }, 'diagonal wheel');
  check('a diagonal wheel scrolls down and sideways', state.scrollLeft > 300 && state.first > beforeSideways.first, `${state.scrollLeft}, ${state.first}`);

  // The Follow switch: off keeps the view at the end while lines arrive; End follows again.
  await evaluate(`document.querySelector('.log-viewport').scrollLeft = 0`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.title === 'Jump to the end and follow').click()`);
  state = await waitFor(async () => { const s = await loaded('end'); return s.follow === 'true' && s.last === lineCount - 1 ? s : false; }, 'End follows');
  await evaluate(`document.querySelector('[aria-label="Follow new lines"]').click()`);
  await waitFor(async () => (await view()).follow === 'false', 'follow off');
  const heldAt = (await view()).first;
  appendLines(50);
  await waitFor(async () => (await view()).text.includes(`${lineCount.toLocaleString('en-US')} lines`), 'line count after append (follow off)');
  await sleep(300);
  check('switching Follow off keeps the view where it was', (await view()).first === heldAt);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.title === 'Jump to the end and follow').click()`);
  state = await waitFor(async () => { const s = await loaded('end again'); return s.last === lineCount - 1 ? s : false; }, 'End again');
  check('End jumps to the end and follows', state.follow === 'true');

  // A block read before an append but answered after the page saw it is
  // read again: the completed last line shows.
  fs.appendFileSync(logFile, 'partial');
  lineCount += 1;
  await waitFor(async () => (await view()).texts.at(-1)?.[1] === 'partial', 'partial last line');
  faults.holdLinesMs = 2500;
  fs.appendFileSync(logFile, ' more');
  await sleep(2500); // a poll sees the new size; the block read is held back
  fs.appendFileSync(logFile, ' done\n');
  faults.holdLinesMs = 0;
  state = await waitFor(async () => { const s = await view(); return s.texts.at(-1)?.[1] === 'partial more done' ? s : false; }, 'completed last line', 20000);
  check('a stale block answered late is read again', true);

  // Find: Ctrl+F (⌘F on macOS), Enter / Shift+Enter / F3, match case, Esc.
  const key = async (keyName, code, keyCode, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const findModifier = process.platform === 'darwin' ? 4 : 2; // Meta : Ctrl
  const findInput = `document.querySelector('input[aria-label="Find in rwr_server.log"]')`;
  const typeQuery = (text) => evaluate(`(() => { const el = ${findInput}; el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const findStatus = () => evaluate(`document.querySelector('.log-search-status')?.innerText ?? ''`);
  const activeRow = () => evaluate(`(() => { const row = document.querySelector('.log-row-active'); return row ? [Number(row.dataset.line), row.querySelector('.log-text').innerText] : null; })()`);
  await evaluate(`document.querySelector('.log-viewport').focus()`);
  await key('Home', 'Home', 36);
  await waitFor(async () => (await view()).first === 0, 'top before searching');
  await key('f', 'KeyF', 70, findModifier);
  await waitFor(async () => evaluate(`document.activeElement === ${findInput}`), 'the find shortcut focuses the find box');
  check('the find shortcut opens the find bar', true);
  await typeQuery('seven');
  check('before a search: a Search button, no match arrows', await evaluate(`[...document.querySelectorAll('.log-search-bar button')].some(b => b.innerText.trim() === 'Search') && !document.querySelector('.log-search-bar button[title="Next match (Enter)"]')`));
  await clickAt(`[...document.querySelectorAll('.log-search-bar button')].find(b => b.innerText.trim() === 'Search')`);
  await waitFor(async () => (await findStatus()).includes('/'), 'search results');
  check('the Search button searches; then the match arrows replace it', await evaluate(`!!document.querySelector('.log-search-bar button[title="Next match (Enter)"]') && ![...document.querySelectorAll('.log-search-bar button')].some(b => b.innerText.trim() === 'Search')`));
  check('a search over the whole file counts its matches, capped with "+"', (await findStatus()) === '1 / 10,000+', await findStatus());
  let active = await waitFor(async () => { const row = await activeRow(); return row && row[0] === 0 ? row : false; }, 'jump to the first match below the view');
  check('the first match from the view is shown and marked as the current row', active[1] === 'line 0 seven');
  check('matches in view are highlighted', await evaluate(`document.querySelectorAll('.log-viewport mark.log-match').length >= 3 && [...document.querySelectorAll('.log-viewport mark.log-match')].every(m => m.innerText === 'seven')`));
  await key('Enter', 'Enter', 13);
  active = await waitFor(async () => { const row = await activeRow(); return row && row[0] === 7 ? row : false; }, 'Enter: next match');
  check('Enter goes to the next match', (await findStatus()) === '2 / 10,000+' && active[1] === 'line 7 seven', await findStatus());
  await key('Enter', 'Enter', 13, 8); // Shift+Enter
  await waitFor(async () => (await activeRow())?.[0] === 0, 'Shift+Enter: previous match');
  check('Shift+Enter goes back', (await findStatus()) === '1 / 10,000+');
  await key('F3', 'F3', 114);
  await waitFor(async () => (await activeRow())?.[0] === 7, 'F3: next match');
  check('F3 goes to the next match', true);
  // Match case by pointer, then Enter: the box keeps the focus and searches.
  await typeQuery('SEVEN');
  await clickAt(`document.querySelector('button[aria-pressed]')`);
  check('clicking "Aa" leaves the focus in the find box', await evaluate(`document.activeElement === ${findInput} && document.querySelector('button[aria-pressed]').getAttribute('aria-pressed') === 'true'`));
  await key('Enter', 'Enter', 13);
  await waitFor(async () => (await findStatus()) === 'No matches', 'case-sensitive search');
  check('match case: "SEVEN" finds nothing', !(await activeRow()));
  await clickAt(`document.querySelector('button[aria-pressed]')`);

  // At the end, a query with more than 10,000 matches: the nearest listed
  // match above, a note that the rest isn't listed, and no wrap-around.
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.title === 'Jump to the end and follow').click()`);
  await waitFor(async () => (await view()).last === lineCount - 1, 'back at the end');
  await typeQuery('line');
  await key('Enter', 'Enter', 13);
  // Lines 0–10000 contain "line", except the long line 10: the 10,000th
  // listed match is line 10000.
  active = await waitFor(async () => { const row = await activeRow(); return row && row[0] === 10000 ? row : false; }, 'nearest listed match above the view');
  check('with only earlier matches listed, the nearest one shows with a note', (await findStatus()).startsWith('10,000 / 10,000+') && (await findStatus()).includes('only the first'), await findStatus());
  await key('Enter', 'Enter', 13);
  await sleep(300);
  check('Enter past the last listed match does not wrap to the top', (await activeRow())?.[0] === 10000);

  // A match far along a long line comes into view sideways.
  fs.appendFileSync(logFile, `${'y'.repeat(3000)} needle-far\n`);
  lineCount += 1;
  await waitFor(async () => (await view()).text.includes(`${lineCount.toLocaleString('en-US')} lines`), 'long line counted');
  await typeQuery('needle-far');
  await key('Enter', 'Enter', 13);
  await waitFor(async () => (await activeRow())?.[0] === lineCount - 1, 'jump to the far match');
  const markInView = await waitFor(() => evaluate(`(() => { const mark = document.querySelector('.log-row-active mark.log-match'); if (!mark) return false; const box = document.querySelector('.log-viewport').getBoundingClientRect(); const r = mark.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right; })()`), 'far match in view', 5000).catch(() => false);
  check('a match far along a long line is scrolled into view sideways', markInView);

  // New lines: "Search again".
  await typeQuery('tick-marker');
  fs.appendFileSync(logFile, 'tick-marker one\n');
  lineCount += 1;
  await waitFor(async () => (await view()).text.includes(`${lineCount.toLocaleString('en-US')} lines`), 'marker line counted');
  await key('Enter', 'Enter', 13);
  await waitFor(async () => (await findStatus()) === '1 / 1', 'one marker');
  fs.appendFileSync(logFile, 'tick-marker two\n');
  lineCount += 1;
  await waitFor(async () => evaluate(`[...document.querySelectorAll('.log-search-bar button')].some(b => b.innerText.includes('Search again'))`), 'Search again offered');
  await evaluate(`[...document.querySelectorAll('.log-search-bar button')].find(b => b.innerText.includes('Search again')).click()`);
  await waitFor(async () => (await findStatus()).endsWith('/ 2'), 'two markers');
  check('new lines offer "Search again", which finds them', true);

  // Esc from anywhere in the bar closes it and gives the keyboard back to the log.
  await evaluate(`document.querySelector('.log-search-bar button[title="Next match (Enter)"]').focus()`);
  await key('Escape', 'Escape', 27);
  await waitFor(async () => evaluate(`!document.querySelector('.log-search-bar')`), 'Esc closes the find bar');
  check('Esc closes the find bar and clears the marks', await evaluate(`document.querySelectorAll('mark.log-match').length === 0 && !document.querySelector('.log-row-active')`));
  check('after Esc the log has the keyboard focus', await evaluate(`document.activeElement === document.querySelector('.log-viewport')`));

  // Emptied and rewritten (a server restart) while scrolled away: notice,
  // new content, following its end.
  await evaluate(`(() => { const s = document.querySelector('.log-viewport'); s.scrollTop = (s.scrollHeight - s.clientHeight) / 3; })()`);
  await waitFor(async () => (await view()).follow === 'false', 'scrolled away before reset');
  fs.writeFileSync(logFile, Array.from({ length: 3000 }, (_, i) => `new run ${i}`).join('\n') + '\n');
  lineCount = 3000;
  state = await waitFor(async () => { const s = await loaded('new run'); return s.text.includes('emptied or replaced') && s.texts.every(([, t]) => t.startsWith('new run')) && s.last === 2999 ? s : false; }, 'reset notice, new content at its end');
  check('a rewritten log shows a notice and follows the new file\'s end', state.follow === 'true' && state.text.includes('3,000 lines'));
  await evaluate(`document.querySelector('.ant-alert-close-icon').click()`);
  await waitFor(async () => !(await view()).text.includes('emptied or replaced'), 'notice closed');

  // Deleted, then created again: no "emptied or replaced" for a file that appears.
  fs.rmSync(logFile);
  await waitFor(async () => (await evaluate('document.body.innerText')).includes('No rwr_server.log yet'), 'missing file notice');
  check('a missing file says so', true);
  fs.writeFileSync(logFile, 'back again\n');
  state = await waitFor(async () => { const s = await view(); return s && s.texts.length === 1 && s.texts[0][1] === 'back again' ? s : false; }, 'file back');
  check('a re-created file shows again, without a reset notice', !state.text.includes('emptied or replaced'));

  // Below the height cap: native scrolling, the same keys.
  await command('Page.navigate', { url: `${base}/server-log/small` });
  state = await waitFor(async () => { const s = await loaded('small log'); return s.last === 2999 ? s : false; }, 'small log at its end');
  check('a small log scrolls natively (not capped)', state.scrollHeight === 3000 * 18, String(state.scrollHeight));
  await evaluate(`document.querySelector('.log-viewport').focus()`);
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await waitFor(async () => (await view()).first === 0, 'small: Home');
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 180 });
  state = await waitFor(async () => { const s = await loaded('small: wheel'); return s.first > 0 ? s : false; }, 'small: wheel');
  check('below the cap the wheel scrolls', state.first >= 5 && state.follow === 'false' && rowsRight(state, (i) => `small ${i}`), String(state.first));
  const smallBefore = state.first;
  for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  state = await waitFor(async () => { const s = await view(); return s.first !== smallBefore ? s : false; }, 'small: Space');
  check('below the cap Space moves a page', Math.abs(state.first - (smallBefore + rowsInView - 1)) <= 1, `${state.first} vs ${smallBefore + rowsInView - 1}`);

  // A phone: wrapped lines, no sideways scrolling.
  await command('Page.navigate', { url: 'about:blank' });
  fs.writeFileSync(logFile, Array.from({ length: 200_000 }, (_, i) => lineText(i)).join('\n') + '\n');
  lineCount = 200_000;
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await command('Page.navigate', { url: `${base}/server-log/demo` });
  state = await waitFor(async () => { const s = await loaded('phone rows'); return s.last === lineCount - 1 ? s : false; }, 'phone: following the end');
  const phone = () => evaluate(`(() => { const s = document.querySelector('.log-viewport'); return { wrap: s.classList.contains('log-wrap'), switch: document.querySelector('[aria-label="Wrap long lines"]').getAttribute('aria-checked'), sideways: s.scrollWidth - s.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth, rows: document.querySelectorAll('.log-row').length }; })()`);
  let p = await phone();
  check('on a phone lines wrap by default', p.wrap && p.switch === 'true');
  check('on a phone nothing scrolls sideways', p.sideways <= 1 && p.page <= 1, JSON.stringify(p));
  check('wrapped: a window of lines, not the whole file, is in the DOM', p.rows <= 400 && p.rows < lineCount, String(p.rows));
  check('wrapped: rows show their lines while following', rowsRight(state, lineText) && state.follow === 'true');
  await evaluate(`document.querySelector('.log-viewport').focus()`);
  await key('Home', 'Home', 36);
  state = await waitFor(async () => { const s = await loaded('phone top'); return s.first === 0 ? s : false; }, 'phone: Home');
  const longHeight = await evaluate(`document.querySelector('.log-row[data-line="${LONG_LINE}"]').getBoundingClientRect().height`);
  check('wrapped: a long line wraps onto several rows', longHeight > 18 * 5, String(longHeight));
  await evaluate(`document.querySelector('.log-viewport').scrollTop = 0`);
  await key('End', 'End', 35);
  await waitFor(async () => (await view()).last === lineCount - 1, 'phone: End key');
  check('wrapped: six-digit line numbers stay on one row', await evaluate(`[...document.querySelectorAll('.log-row .log-gutter')].filter(g => g.innerText.length === 6).every(g => g.getBoundingClientRect().height <= 18.5)`));
  // Follow off at the end, lines arrive: they can be scrolled to.
  await evaluate(`document.querySelector('[aria-label="Follow new lines"]').click()`);
  await waitFor(async () => (await view()).follow === 'false', 'phone: follow off');
  appendLines(60);
  await waitFor(async () => (await view()).text.includes(`${lineCount.toLocaleString('en-US')} lines`), 'phone: appended lines counted');
  await sleep(500);
  for (let i = 0; i < 6; i++) { await evaluate(`document.querySelector('.log-viewport').scrollBy(0, 2000)`); await sleep(150); }
  state = await waitFor(async () => { const s = await loaded('phone: new lines'); return s.last === lineCount - 1 ? s : false; }, 'phone: scroll down to the new lines', 10000);
  check('wrapped: lines appended while not following can be scrolled to', rowsRight(state, lineText));
  await key('Home', 'Home', 36);
  state = await waitFor(async () => { const s = await loaded('phone top again'); return s.first === 0 ? s : false; }, 'phone: Home again');
  // Scroll down through several window slides: the line at the top never jumps.
  let jumps = 0;
  let previous = state.first;
  for (let i = 0; i < 25; i++) {
    const before = await evaluate(`(() => { const s = document.querySelector('.log-viewport'); const top = s.getBoundingClientRect().top; const row = [...document.querySelectorAll('.log-row')].find(r => r.getBoundingClientRect().bottom > top + 1); return { line: Number(row.dataset.line), offset: row.getBoundingClientRect().top - top }; })()`);
    await evaluate(`document.querySelector('.log-viewport').scrollBy(0, 600)`);
    await sleep(120);
    const after = await evaluate(`(() => { const s = document.querySelector('.log-viewport'); const top = s.getBoundingClientRect().top; const row = document.querySelector('.log-row[data-line="${'${'}line}"]'); return row ? row.getBoundingClientRect().top - top : null; })()`.replace('${line}', String(before.line)));
    if (after !== null && Math.abs(after - (before.offset - 600)) > 30) jumps += 1;
    const now = (await view()).first;
    if (now < previous) jumps += 1;
    previous = now;
  }
  state = await loaded('phone after scrolling');
  check('wrapped: scrolling through window slides keeps the view still', jumps === 0 && state.first > 300, `${jumps} jumps, at line ${state.first}`);
  check('wrapped: rows still show their lines', rowsRight(state, lineText));
  // The slider: tap the middle of its rail.
  await clickAt(`document.querySelector('.log-position .ant-slider-rail')`);
  state = await waitFor(async () => { const s = await loaded('slider jump'); return Math.abs(s.first - lineCount / 2) < lineCount * 0.05 ? s : false; }, 'slider jump to the middle');
  check('wrapped: the position slider jumps anywhere in the file', rowsRight(state, lineText) && state.follow === 'false', String(state.first));
  // Search jumps to a far line.
  await evaluate(`document.querySelector('[aria-label="Find in rwr_server.log"]').click()`);
  await waitFor(async () => evaluate(`!!${findInput}`), 'phone: find bar');
  await typeQuery('line 177777 other');
  await clickAt(`[...document.querySelectorAll('.log-search-bar button')].find(b => b.innerText.trim() === 'Search')`);
  active = await waitFor(async () => { const row = await activeRow(); return row && row[0] === 177777 ? row : false; }, 'phone: search jump');
  check('wrapped: a search jumps to its match', await evaluate(`(() => { const s = document.querySelector('.log-viewport').getBoundingClientRect(); const r = document.querySelector('.log-row-active').getBoundingClientRect(); return r.top >= s.top && r.bottom <= s.bottom; })()`));
  await key('Escape', 'Escape', 27);
  // End follows again.
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.title === 'Jump to the end and follow').click()`);
  state = await waitFor(async () => { const s = await loaded('phone end'); return s.last === lineCount - 1 && s.follow === 'true' ? s : false; }, 'phone: End');
  check('wrapped: End follows the end again', true);
  // The slider all the way right follows the end.
  await evaluate(`document.querySelector('[aria-label="Follow new lines"]').click()`);
  await waitFor(async () => (await view()).follow === 'false', 'phone: follow off again');
  await evaluate(`document.querySelector('.log-position .ant-slider-handle').focus()`);
  await key('End', 'End', 35);
  await waitFor(async () => (await view()).follow === 'true', 'slider at the end follows');
  check('wrapped: the slider at its end follows the end again', true);

  // Switching Wrap keeps the reader's place.
  await clickAt(`document.querySelector('.log-position .ant-slider-rail')`);
  state = await waitFor(async () => { const s = await loaded('phone: middle'); return s.follow === 'false' && Math.abs(s.first - lineCount / 2) < lineCount * 0.05 ? s : false; }, 'phone: middle again');
  const placeBefore = state.first;
  check('wrapped: the slider shows the line it jumped to', await evaluate(`document.querySelector('.log-position-label').innerText.startsWith(${JSON.stringify((placeBefore + 1).toLocaleString('en-US'))})`), await evaluate(`document.querySelector('.log-position-label').innerText`));
  await evaluate(`document.querySelector('[aria-label="Wrap long lines"]').click()`);
  await waitFor(async () => !(await phone()).wrap, 'wrap off');
  state = await loaded('unwrapped place');
  check('switching Wrap off keeps the place', Math.abs(state.first - placeBefore) <= 1, `${state.first} vs ${placeBefore}`);
  await evaluate(`document.querySelector('[aria-label="Wrap long lines"]').click()`);
  await waitFor(async () => (await phone()).wrap, 'wrap on');
  state = await loaded('wrapped place');
  check('switching Wrap on keeps the place', Math.abs(state.first - placeBefore) <= 1, `${state.first} vs ${placeBefore}`);

  // Long wrapped lines: a far search match stays in view as the lines
  // around it load and grow; a match deep in a long line too.
  await command('Page.navigate', { url: `${base}/server-log/wide` });
  await waitFor(async () => { const s = await view(); return s && s.texts.length > 0; }, 'wide log');
  const markVisible = () => evaluate(`(() => { const s = document.querySelector('.log-viewport').getBoundingClientRect(); const target = document.querySelector('.log-row-active mark.log-match') ?? document.querySelector('.log-row-active'); if (!target) return false; const r = target.getBoundingClientRect(); return r.top >= s.top && r.top < s.bottom; })()`);
  await evaluate(`document.querySelector('[aria-label="Find in rwr_server.log"]').click()`);
  await waitFor(async () => evaluate(`!!${findInput}`), 'wide: find bar');
  await typeQuery('wide 30000 ');
  await clickAt(`[...document.querySelectorAll('.log-search-bar button')].find(b => b.innerText.trim() === 'Search')`);
  await waitFor(async () => (await activeRow())?.[0] === 30000, 'wide: far match').catch(async (error) => {
    console.error('[log-ui] find bar:', JSON.stringify({ status: await findStatus(), active: await activeRow(), query: await evaluate(`${findInput}?.value`), buttons: await evaluate(`[...document.querySelectorAll('.log-search-bar button')].map(b => b.innerText.trim() + (b.disabled ? ' (disabled)' : ''))`), rows: (await view())?.texts?.slice(0, 2) }));
    throw error;
  });
  await sleep(1500); // the lines around it load and wrap
  check('wrapped: a far match stays in view once the lines around it load', await markVisible());
  await typeQuery('deep-needle');
  await key('Enter', 'Enter', 13);
  await waitFor(async () => (await activeRow())?.[0] === 1500, 'wide: deep match');
  await sleep(1000);
  check('wrapped: a match deep in a long line is brought into view', await markVisible());
  await key('Escape', 'Escape', 27);

  // Landscape on a touch screen still wraps.
  await command('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await evaluate(`localStorage.removeItem('squash.serverLog.wrap')`);
  await command('Page.reload');
  await waitFor(async () => { const s = await view(); return s && s.texts.length > 0; }, 'landscape');
  check('a touch screen in landscape wraps by default', (await phone()).wrap);

  // A tall desktop window with Wrap on: scrolling down keeps going.
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 2400, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${base}/server-log/small` });
  await waitFor(async () => { const s = await view(); return s && s.texts.length > 0; }, 'tall: small log');
  if (!(await phone()).wrap) await evaluate(`document.querySelector('[aria-label="Wrap long lines"]').click()`);
  await waitFor(async () => (await phone()).wrap, 'tall: wrap on');
  await evaluate(`document.querySelector('.log-viewport').focus()`);
  await key('Home', 'Home', 36);
  await waitFor(async () => (await view()).first === 0, 'tall: top');
  for (let i = 0; i < 12; i++) { await evaluate(`document.querySelector('.log-viewport').scrollBy(0, 1500)`); await sleep(150); }
  state = await loaded('tall: scrolled');
  check('a tall window with Wrap on keeps scrolling down', state.first > 900 && rowsRight(state, (i) => `small ${i}`), String(state.first));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await command('Page.navigate', { url: `${base}/server-log/demo` });
  await waitFor(async () => { const s = await view(); return s && s.texts.length > 0; }, 'phone again');

  // The Wrap switch: off gives fixed rows, and the choice is remembered.
  if (!(await phone()).wrap) await evaluate(`document.querySelector('[aria-label="Wrap long lines"]').click()`);
  await evaluate(`document.querySelector('[aria-label="Wrap long lines"]').click()`);
  await waitFor(async () => !(await phone()).wrap, 'wrap off');
  await command('Page.reload');
  await waitFor(async () => { const s = await view(); return s && s.texts.length > 0; }, 'reloaded');
  check('the Wrap choice is remembered', !(await phone()).wrap && (await phone()).switch === 'false');
  await evaluate(`document.querySelector('[aria-label="Wrap long lines"]').click()`);
  await waitFor(async () => (await phone()).wrap, 'wrap on again');
  await command('Emulation.clearDeviceMetricsOverride');
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });

  await command('Page.navigate', { url: `${base}/server-log/ghost` });
  await waitFor(async () => (await evaluate('document.body.innerText')).includes('Instance ghost not found'), 'unknown instance');
  check('an unknown instance shows an error', true);
  check('no page errors', pageErrors.length === 0, pageErrors.join('\n'));
} catch (error) {
  failed = true;
  console.error(error.stack ?? error);
  if (pageErrors.length > 0) console.error('Page errors:\n' + pageErrors.join('\n---\n'));
  if (socket?.readyState === WebSocket.OPEN) {
    try { console.error('Page text:', (await evaluate('document.body.innerText')).slice(0, 1500)); } catch { /* keep the original failure */ }
  }
} finally {
  try {
    if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch { /* the browser closes the transport */ } }
    socket?.close();
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error('Cleanup')); }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      try { await waitFor(() => browser.exitCode !== null || browser.signalCode !== null, 'browser exits', 5000); }
      catch {
        if (process.platform === 'win32') spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true });
        else browser.kill('SIGKILL');
      }
    }
    await server.close();
    fs.rmSync(work, { recursive: true, force: true });
  } catch (error) { failed = true; console.error(`Cleanup failed: ${error.stack}`); }
  console.log(`[log-ui] ${checks.filter(item => item.passed).length}/${checks.length} passed; failed=${failed}`);
}
process.exitCode = failed ? 1 : 0;
