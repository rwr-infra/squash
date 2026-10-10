import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/**
 * The browser the browser tests drive: SQUASH_BROWSER_PATH, or Chrome,
 * Chromium or Edge where they usually live. Undefined when there is none.
 */
export const findBrowser = (): string | undefined => {
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const browserPath = process.env.SQUASH_BROWSER_PATH ?? candidates.find((candidate) => fs.existsSync(candidate));
  return browserPath && fs.existsSync(browserPath) ? browserPath : undefined;
};

// CDP results, as the protocol returns them.
type Result = any;
type Call = { readonly resolve: (value: Result) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const poll = async <T>(predicate: () => T, label: string, ms: number): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  do { const value = predicate(); if (value) return value; await sleep(50); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
};

/**
 * A headless browser with a fresh profile in `profileDir`, at about:blank in
 * a 1280×900 window, driven over the DevTools protocol (no driver library):
 * `connect()` attaches to its page; `command` sends a CDP command (rejected
 * after `commandTimeoutMs`); `evaluate` runs an expression in the page and
 * returns its value; `pageErrors` collects uncaught exceptions and
 * console.error calls (Runtime.enable turns them on). `close()` closes the
 * browser — killing it if it does not exit within 5 s — and can be called at
 * any point, also before or after a failed `connect()`; it returns what went
 * wrong (a browser still running 5 s after the kill), never throws.
 */
export const startBrowser = (options: {
  readonly browserPath: string;
  readonly profileDir: string;
  readonly endpointTimeoutMs: number;
  readonly commandTimeoutMs: number;
}) => {
  const child = spawn(options.browserPath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${options.profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.once('error', (error) => { output += error.message; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.stdout.on('data', (chunk) => { output += chunk; });
  const running = () => child.exitCode === null && child.signalCode === null;

  let socket: WebSocket | undefined;
  const calls = new Map<number, Call>();
  let sequence = 0;
  const pageErrors: string[] = [];

  const command = (method: string, params: object = {}) => new Promise<Result>((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) {
      reject(new Error(`CDP not connected: ${method}`));
      return;
    }
    const id = ++sequence;
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, options.commandTimeoutMs);
    calls.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string): Promise<Result> => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };

  const connect = async () => {
    const endpoint = await poll(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(output)?.[1], 'browser debugging endpoint', options.endpointTimeoutMs);
    const pages = await (await fetch(`${new URL(endpoint).origin.replace('ws:', 'http:')}/json/list`)).json() as Result[];
    const page = pages.find((item) => item.type === 'page');
    if (!page) throw new Error('Browser has no page to attach to');
    const opened = new WebSocket(page.webSocketDebuggerUrl);
    socket = opened;
    await new Promise((resolve, reject) => { opened.onopen = resolve; opened.onerror = reject; });
    opened.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Result;
      if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageErrors.push(message.params.args.map((arg: Result) => arg.value ?? arg.description).join(' '));
      const call = calls.get(message.id);
      if (!call) return;
      clearTimeout(call.timer); calls.delete(message.id);
      if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
    };
  };

  const isOpen = () => socket?.readyState === WebSocket.OPEN;

  const close = async (): Promise<string | undefined> => {
    if (isOpen()) { try { await command('Browser.close'); } catch { /* the browser closes the transport */ } }
    socket?.close();
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error('Cleanup')); }
    calls.clear();
    if (!running()) return undefined;
    try {
      await poll(() => !running(), 'browser exits', 5000);
      return undefined;
    } catch {
      if (process.platform === 'win32') spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
      return poll(() => !running(), 'browser killed', 5000).then(() => undefined, () => `Browser ${child.pid} still running 5 s after it was killed`);
    }
  };

  return { command, evaluate, pageErrors, connect, isOpen, close };
};

export type Browser = ReturnType<typeof startBrowser>;
