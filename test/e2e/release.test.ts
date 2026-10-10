// The FINAL release archive for the current platform/arch, run the way a user
// would run it: extracted into a path with spaces, parentheses, `&` and
// non-ASCII characters, with every `node` stripped from PATH, .env.example
// copied to .env, and the bundle started through its launcher (start.sh /
// start.bat). Checks:
//   - the archive ships no .env; the bundled runtime runs and matches
//     build-info.json; the frontend has no dev API origin baked in
//   - default config listens on loopback only (probed from a LAN address too)
//   - GET /api/health, GET / (frontend), login admin/admin, 401 without token
//   - a shell instance round-trips PTY input/output in both directions:
//     WebSocket input → WebSocket output, and the command-capture endpoint
//   - stopping the instance ends in `stopped` (not `crashed`)
//   - terminating the LAUNCHER stops the server and frees the port; on POSIX
//     (SIGTERM, sent twice as a terminal or npm often does) squash first stops
//     its instances — one that ignores SIGHUP is force-killed after its
//     stopTimeoutMs rather than orphaned — and exits 0, also with no instances
//   - a strong password + HOST=0.0.0.0 listens on all interfaces
//   - weak protection + HOST=0.0.0.0 is refused (default password written in
//     .env, credentials unset, auth disabled) with the operator hint and no
//     listen
//
// Usage: npm run package && npm run smoke:release
// Default archive: release/squash-<version>-<platform>-<arch>.(zip|tar.gz);
// SQUASH_RELEASE_ARCHIVE=<path> tests another one.
//
// The flow is the former smoke's, run once (test/helpers/checks.ts). As in
// the smoke, a failed check does not stop it; an error in the default-config
// section ends that section only, and fails "the flow ends without an error".
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { tarCommand } from '../../scripts/node-runtime.mjs';
import { recordedChecks } from '../helpers/checks.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isWindows = process.platform === 'win32';
// The flow's own limit; CI gives the step 10 minutes.
const FLOW_TIMEOUT_MS = 480_000;

// A non-loopback IPv4 address of this machine, to prove what a loopback bind
// really excludes. Undefined when the host has none (then those probes skip).
// Read while tests are collected: the labels name it.
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((addr) => addr && addr.family === 'IPv4' && !addr.internal)?.address;

const refusalCases: readonly (readonly [string, (port: number) => void, string])[] = [
  ['password from the copied .env.example', (p) => writeEnv(p), 'the default password (admin) is in use'],
  ['no .env (credentials unset)', () => fs.rmSync(envFile, { force: true }), 'the default password (admin) is in use'],
  ['AUTH_PASSWORD= empty, no token', (p) => writeEnv(p, (t) => t.replace(/^AUTH_PASSWORD=.*$/m, 'AUTH_PASSWORD=')), 'authentication is disabled']
];
const refusalLabel = (label: string) => `refused (${label}): exit 1, fatal hint, never listened`;

const posixOnly = (label: string) => ({ label, skip: isWindows });
const lanOnly = (label: string) => ({ label, skip: !lanAddress });
const { check: record, run } = recordedChecks([
  'archive ships no .env',
  'bundled runtime runs and matches build-info',
  'frontend has no baked API origin',
  'no `node` resolvable from the launcher env',
  '.env.example does not set HOST',
  'server started',
  'logs a loopback bind',
  lanOnly(`not reachable via LAN address ${lanAddress ?? '(none)'}`),
  'GET /api/health',
  'GET / serves the frontend',
  'login admin/admin',
  'API rejects requests without a token',
  'create shell instance',
  'start shell instance',
  'terminal WebSocket connects',
  'PTY round-trip via WebSocket input/output',
  'PTY round-trip via command capture',
  'command output also streams to WebSocket viewers',
  'stop shell instance',
  'stopped instance ends in `stopped` (not `crashed`)',
  posixOnly('create a SIGHUP-ignoring instance'),
  posixOnly('start it'),
  'terminating the launcher stops the server',
  posixOnly('launcher exits 0 after stopping its instances'),
  posixOnly('no orphaned instance process after shutdown'),
  posixOnly('instance log shows the shutdown stop and its force-kill'),
  'port released after exit',
  'strong password + HOST=0.0.0.0 binds 0.0.0.0',
  lanOnly(`reachable via LAN address ${lanAddress ?? '(none)'}`),
  posixOnly('with no instances the launcher exits 0 too'),
  ...refusalCases.map(([label]) => refusalLabel(label))
]);

// API payloads and log lines, as squash writes them; the checks are what pins
// their shape down.
type Json = Record<string, any>;
type Closed = { readonly code: number | null; readonly signal: NodeJS.Signals | null };
type Proc = {
  readonly child: ChildProcess;
  readonly output: () => string;
  isClosed: boolean;
  closed: Promise<Closed>;
};

const log = (msg: string) => console.log(`[smoke] ${msg}`);
let anyFailed = false;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) anyFailed = true;
  return record(label, ok, detail);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => Promise.race([promise, sleep(ms).then(() => undefined)]);
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const tail = (text: string, n = 600) => JSON.stringify(text.slice(-n));
// ConPTY and shells emit cursor/colour sequences that could split a marker.
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

// Set up by the flow, not while tests are collected: a filter that skips the
// file runs no hook, and nothing made earlier would be cleaned up.
let workRoot = '';
let appDir = '';
let envFile = '';
let template = '';
let baseEnv: NodeJS.ProcessEnv = {};
const serverLogs: [string, Proc][] = [];
// Set once the SIGHUP-ignoring instance of section 1 runs (POSIX only).
let orphan: { readonly pid: number; readonly readLog: () => string; ready: boolean } | undefined;

const writeEnv = (port: number, edit = (text: string) => text) =>
  fs.writeFileSync(envFile, edit(template.replace(/^PORT=.*$/m, `PORT=${port}`)));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });

// 'connected' | error code (e.g. ECONNREFUSED) | 'timeout'
const tcpProbe = (host: string, port: number, ms = 3000) =>
  new Promise<string>((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: string) => { socket.destroy(); resolve(result); };
    socket.setTimeout(ms, () => done('timeout'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code ?? err.message));
  });

// Set by cleanup: a flow that overran its time and goes on starts nothing
// more, since nothing would stop it.
let stopping = false;

const launch = (extraEnv: NodeJS.ProcessEnv = {}): Proc => {
  if (stopping) throw new Error('cleanup has begun: no more launchers');
  const env = { ...baseEnv, ...extraEnv };
  // Start from an unrelated cwd: the launcher itself must cd into the bundle.
  // POSIX: own process group, so cleanup can kill whatever the launcher left.
  const opts = { cwd: workRoot, env, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], detached: !isWindows };
  // `cmd /s /c` strips ONE outer pair of quotes, so a path with spaces needs
  // two: ""C:\...\start.bat"". Verbatim args keep Node from re-quoting it.
  const child = isWindows
    ? spawn('cmd.exe', ['/d', '/s', '/c', `""${path.join(appDir, 'start.bat')}""`], { ...opts, windowsVerbatimArguments: true })
    : spawn(path.join(appDir, 'start.sh'), [], opts);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (s: string) => { output += s; });
  child.stderr.on('data', (s: string) => { output += s; });
  child.on('error', (err) => { output += `\n[smoke] spawn error: ${err.message}\n`; });
  const proc: Proc = { child, output: () => output, isClosed: false, closed: Promise.resolve({ code: null, signal: null }) };
  // 'close', not 'exit': it fires only once every holder of the stdio pipes is
  // gone, so a server orphaned by its launcher keeps it pending.
  proc.closed = new Promise((resolve) => child.on('close', (code, signal) => { proc.isClosed = true; resolve({ code, signal }); }));
  return proc;
};

const forceKill = (proc: Proc) => {
  if (isWindows) {
    try { execFileSync('taskkill', ['/pid', String(proc.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else {
    try { process.kill(-proc.child.pid!, 'SIGKILL'); } catch { /* gone */ }
  }
};

// Terminates the launcher the way an operator or service manager would (the
// launcher PID only — on POSIX start.sh must `exec` node for this to work) and
// reports whether everything exited, and how. Always cleans up afterwards.
// `twice` repeats the POSIX signal shortly after, the way one keypress or
// closed window often delivers it twice.
const terminate = async (proc: Proc, { twice = false } = {}): Promise<{ readonly exited: boolean } & Partial<Closed>> => {
  if (proc.isClosed) return { exited: true, ...(await proc.closed) };
  if (isWindows) {
    try { execFileSync('taskkill', ['/pid', String(proc.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else {
    try { process.kill(proc.child.pid!, 'SIGTERM'); } catch { /* gone */ }
    if (twice) {
      await sleep(20);
      try { process.kill(proc.child.pid!, 'SIGTERM'); } catch { /* gone */ }
    }
  }
  const outcome = await withTimeout(proc.closed, 15000);
  if (!outcome) {
    forceKill(proc);
    await withTimeout(proc.closed, 5000);
    return { exited: false };
  }
  return { exited: true, ...outcome };
};

const findLogLine = (text: string, predicate: (json: Json) => unknown): Json | undefined => {
  for (const line of text.split(/\r?\n/)) {
    try {
      const json = JSON.parse(line) as Json;
      if (predicate(json)) return json;
    } catch { /* not JSON */ }
  }
  return undefined;
};
const isRunningLine = (j: Json) => j.msg === 'HTTP server running';

const waitFor = async <T>(predicate: () => T | Promise<T>, timeoutMs: number, intervalMs = 200): Promise<NonNullable<T> | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return undefined;
};

// Resolves with the "HTTP server running" log line, or undefined if the
// launcher exits (or 60s pass) first — no point waiting on a dead process.
const waitForListening = (proc: Proc) =>
  waitFor(() => findLogLine(proc.output(), isRunningLine) ?? (proc.isClosed ? 'closed' : undefined), 60000).then(
    (result) => (result && result !== 'closed' ? result as Json : undefined)
  );

const api = async (port: number, method: string, url: string, { token, body, host = '127.0.0.1' }: { readonly token?: string; readonly body?: unknown; readonly host?: string } = {}) => {
  const res = await fetch(`http://${host}:${port}${url}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let json: Json | undefined;
  try { json = JSON.parse(text) as Json; } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
};

const flow = async () => {
  // --- Locate & extract ---------------------------------------------------------
  const defaultArchive = () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as Json;
    return path.join(rootDir, 'release', `squash-${version}-${process.platform}-${process.arch}.${isWindows ? 'zip' : 'tar.gz'}`);
  };
  const archiveArg = process.env.SQUASH_RELEASE_ARCHIVE || undefined;
  const archive = path.resolve(archiveArg ?? defaultArchive());
  if (!fs.existsSync(archive)) throw new Error(`archive not found: ${archive} — run \`npm run package\` first.`);

  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-smoke-'));
  // Parentheses guard start.bat against "Program Files (x86)"-style paths; `&` is
  // a cmd metacharacter; the CJK part exercises non-ASCII handling. No `%`: cmd
  // would expand it.
  appDir = path.join(workRoot, 'squash smoke (x86) & 测试');
  fs.mkdirSync(appDir);
  log(`extracting ${path.basename(archive)} → ${appDir}`);
  // Pass the destination as cwd, not `-C`: Windows' bsdtar converts argv through
  // the ANSI code page, which mangles non-ASCII paths (libarchive#2092); cwd goes
  // through the Unicode CreateProcessW path.
  execFileSync(tarCommand(), ['-xf', archive], { cwd: appDir, stdio: 'inherit' });

  // --- Static checks on the extracted bundle -----------------------------------
  check('archive ships no .env', !fs.existsSync(path.join(appDir, '.env')));

  const buildInfo = JSON.parse(fs.readFileSync(path.join(appDir, 'build-info.json'), 'utf8')) as Json;
  if (!archiveArg) {
    // Testing the default archive from a checkout: flag a stale bundle.
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (buildInfo.commit !== head || buildInfo.dirty) {
        log(`warning: archive was built from ${buildInfo.commit}${buildInfo.dirty ? ' (dirty)' : ''}, HEAD is ${head}`);
      }
    } catch { /* not a git checkout */ }
  }

  const runtimeNode = path.join(appDir, 'runtime', isWindows ? 'node.exe' : 'node');
  let runtimeVersion = '';
  try {
    runtimeVersion = execFileSync(runtimeNode, ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    runtimeVersion = `failed: ${(err as Error).message}`;
  }
  check('bundled runtime runs and matches build-info', runtimeVersion === `v${buildInfo.node}`, `${runtimeVersion} vs v${buildInfo.node}`);

  // A dev-only VITE_API_URL/VITE_WS_URL baked into the frontend would send every
  // user's browser elsewhere. Two tells: any absolute origin followed by /api (how
  // the frontend composes its endpoints), and loopback URLs with an explicit port
  // (libraries only use bare fallbacks like "http://localhost").
  const assetsDir = path.join(appDir, 'frontend', 'dist', 'assets');
  const bakedOrigins = fs
    .readdirSync(assetsDir)
    .filter((file) => file.endsWith('.js'))
    .flatMap((file) => {
      const text = fs.readFileSync(path.join(assetsDir, file), 'utf8');
      return [
        ...(text.match(/(?:https?|wss?):\/\/[^"'`\s)]+\/api\b/g) ?? []),
        ...(text.match(/(?:https?|wss?):\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]):\d+/g) ?? [])
      ];
    });
  check('frontend has no baked API origin', bakedOrigins.length === 0, [...new Set(bakedOrigins)].join(', '));

  // --- Environment without any system Node ---------------------------------------
  const nodeNames = isWindows ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  const pathKeys = Object.keys(process.env).filter((k) => /^path$/i.test(k));
  const originalPath = pathKeys.map((k) => process.env[k]).join(path.delimiter);
  const removedDirs: string[] = [];
  const cleanPath = originalPath
    .split(path.delimiter)
    .filter((dir) => {
      if (!dir) return false;
      const hasNode = nodeNames.some((n) => fs.existsSync(path.join(dir, n)));
      if (hasNode) removedDirs.push(dir);
      return !hasNode;
    })
    .join(path.delimiter);
  if (removedDirs.length) log(`removed from PATH (they contain node): ${removedDirs.join(', ')}`);

  baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    // Drop anything that could leak the build's Node/npm or pre-set our config,
    // and every spelling of PATH (Windows may carry both Path and PATH).
    if (/^(npm_|NODE_|HOST$|PORT$|AUTH_|LOG_LEVEL$|SQUASH_|path$)/i.test(key)) delete baseEnv[key];
  }
  baseEnv.PATH = cleanPath;
  baseEnv.SQUASH_NO_PAUSE = '1';

  // Probe with the real env the launcher gets, not the list we computed.
  const nodeLookup = isWindows
    ? spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), ['node'], { env: baseEnv, encoding: 'utf8' })
    : spawnSync('/bin/sh', ['-c', 'command -v node'], { env: baseEnv, encoding: 'utf8' });
  check('no `node` resolvable from the launcher env', nodeLookup.status !== 0 && !nodeLookup.error, (nodeLookup.stdout ?? '').trim());

  if (!lanAddress) log('no non-loopback IPv4 address found — LAN reachability probes will be skipped');

  template = fs.readFileSync(path.join(appDir, '.env.example'), 'utf8');
  check('.env.example does not set HOST', !/^\s*HOST\s*=/m.test(template));
  envFile = path.join(appDir, '.env');

  // --- 1. Default config: full user journey --------------------------------------
  let sectionError: unknown;
  const port = await freePort();
  writeEnv(port);
  log(`starting bundle via ${isWindows ? 'start.bat' : 'start.sh'} on port ${port} (.env copied from .env.example)`);
  const server = launch();
  serverLogs.push(['default config', server]);
  const running = await waitForListening(server);

  try {
    if (!check('server started', Boolean(running), running ? '' : `output: ${tail(server.output(), 2000)}`)) throw new Error('abort');
    check('logs a loopback bind', running!.host === '127.0.0.1', `host=${running!.host}`);
    if (lanAddress) {
      const probe = await tcpProbe(lanAddress, port);
      check(`not reachable via LAN address ${lanAddress}`, probe !== 'connected', probe);
    }

    const health = await api(port, 'GET', '/api/health');
    check('GET /api/health', health.status === 200 && health.json?.success === true, `status=${health.status}`);

    const index = await api(port, 'GET', '/');
    check(
      'GET / serves the frontend',
      index.status === 200 && (index.headers.get('content-type') ?? '').includes('text/html') && index.text.includes('<div id="root"'),
      `status=${index.status}`
    );

    const loginRes = await api(port, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin' } });
    const token = loginRes.json?.data?.token as string | undefined;
    check('login admin/admin', loginRes.status === 200 && Boolean(token), `status=${loginRes.status}`);

    const denied = await api(port, 'GET', '/api/instances');
    check('API rejects requests without a token', denied.status === 401, `status=${denied.status}`);

    // PTY round-trips. The marker's digits come only from the instance env, so
    // the PTY's echo of the typed command can't satisfy a check — only real shell
    // output can.
    const secret = crypto.randomInt(100000, 999999).toString();
    const shellCwd = path.join(workRoot, 'instance cwd');
    fs.mkdirSync(shellCwd);
    const instanceId = 'smoke-shell';
    const created = await api(port, 'POST', '/api/instances', {
      token,
      body: {
        id: instanceId,
        name: 'smoke shell',
        cwd: shellCwd,
        executable: isWindows ? 'cmd.exe' : '/bin/sh',
        args: [],
        env: { SQUASH_SMOKE: secret },
        autoRestart: false
      }
    });
    check('create shell instance', created.status === 200 || created.status === 201, `status=${created.status}`);

    const started = await api(port, 'POST', `/api/instances/${instanceId}/start`, { token });
    check('start shell instance', started.status === 200, `status=${started.status} ${started.text.slice(0, 300)}`);

    const wsChunks: string[] = [];
    const wsText = () => stripAnsi(wsChunks.join(''));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${instanceId}?token=${encodeURIComponent(String(token))}`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Json;
        if (msg.type === 'output') wsChunks.push(msg.data);
      } catch { /* ignore */ }
    };
    const wsOpen = await withTimeout(
      new Promise<boolean>((resolve) => { ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); }),
      10000
    );
    check('terminal WebSocket connects', Boolean(wsOpen));

    await sleep(1500); // let the shell print its prompt
    const echo = (suffix: string) => (isWindows ? `echo smoke-%SQUASH_SMOKE%-${suffix}` : `echo smoke-$SQUASH_SMOKE-${suffix}`);

    // Browser path: keystrokes go in as WS `input` messages.
    if (wsOpen) ws.send(JSON.stringify({ type: 'input', data: `${echo('ws')}\r` }));
    const wsRoundTrip = await waitFor(() => wsText().includes(`smoke-${secret}-ws`), 8000);
    check('PTY round-trip via WebSocket input/output', Boolean(wsRoundTrip), wsRoundTrip ? '' : `ws output: ${tail(wsText())}`);

    // API path: POST /command with an output capture window.
    const captured = await api(port, 'POST', `/api/instances/${instanceId}/command`, { token, body: { command: echo('api'), captureMs: 3000 } });
    const capturedOutput = stripAnsi(captured.json?.data?.output ?? '');
    check(
      'PTY round-trip via command capture',
      captured.status === 200 && capturedOutput.includes(`smoke-${secret}-api`),
      captured.status === 200 && capturedOutput.includes(`smoke-${secret}-api`) ? '' : `status=${captured.status} output: ${tail(capturedOutput)}`
    );
    const wsSawApi = await waitFor(() => wsText().includes(`smoke-${secret}-api`), 5000);
    check('command output also streams to WebSocket viewers', Boolean(wsSawApi));
    ws.close();

    const stopped = await api(port, 'POST', `/api/instances/${instanceId}/stop`, { token });
    check('stop shell instance', stopped.status === 200, `status=${stopped.status} ${stopped.text.slice(0, 300)}`);
    let finalStatus: string | undefined;
    await waitFor(async () => {
      const got = await api(port, 'GET', `/api/instances/${instanceId}`, { token });
      finalStatus = got.json?.data?.runtime?.status;
      return finalStatus === 'stopped' || finalStatus === 'crashed';
    }, 15000, 500);
    check('stopped instance ends in `stopped` (not `crashed`)', finalStatus === 'stopped', `status=${finalStatus}`);
    await api(port, 'DELETE', `/api/instances/${instanceId}`, { token });

    // An instance that ignores SIGHUP survives the PTY closing, so only squash
    // stopping it on the way out (force-kill after its stopTimeoutMs) keeps it
    // from being orphaned. Windows can't take this path here: terminate() uses
    // taskkill /T /F, which never reaches squash's signal handling.
    if (!isWindows) {
      const orphanId = 'smoke-orphan';
      const orphanLogDir = path.join(workRoot, 'orphan logs');
      const orphanCreated = await api(port, 'POST', '/api/instances', {
        token,
        body: {
          id: orphanId,
          name: 'smoke orphan',
          cwd: shellCwd,
          executable: '/bin/sh',
          args: ['-c', 'trap "" HUP; echo orphan-ready; while :; do sleep 1; done'],
          logDir: orphanLogDir,
          autoRestart: false,
          stopTimeoutMs: 2000
        }
      });
      check('create a SIGHUP-ignoring instance', orphanCreated.status === 200 || orphanCreated.status === 201, `status=${orphanCreated.status} ${orphanCreated.text.slice(0, 300)}`);
      const orphanStarted = await api(port, 'POST', `/api/instances/${orphanId}/start`, { token });
      const orphanPid = orphanStarted.json?.data?.pid as number | undefined;
      const logFile = path.join(orphanLogDir, `${orphanId}.log`);
      const readLog = () => {
        try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; }
      };
      // Kill it on the way out whatever happens: it would outlive a failed run.
      if (orphanPid! > 0) orphan = { pid: orphanPid!, readLog, ready: false };
      // Its trap is in place once it has printed.
      const ready = await waitFor(() => readLog().includes('orphan-ready'), 8000);
      if (check('start it', orphanStarted.status === 200 && orphanPid! > 0 && Boolean(ready), `status=${orphanStarted.status} pid=${orphanPid}`)) {
        orphan!.ready = true;
      }
    }
  } catch (err) {
    if ((err as Error).message !== 'abort') {
      sectionError = err;
      console.error(`[smoke] the default-config section failed: ${(err as Error).stack}`);
    }
  } finally {
    const result = await terminate(server, { twice: Boolean(orphan) });
    check('terminating the launcher stops the server', result.exited);
    if (orphan?.ready) {
      check('launcher exits 0 after stopping its instances', result.code === 0, `code=${result.code} signal=${result.signal}`);
      // Right away, no grace period: squash must not exit before its instance.
      const gone = !isAlive(orphan.pid);
      check('no orphaned instance process after shutdown', gone, gone ? '' : `pid ${orphan.pid} still alive`);
      const instanceLog = orphan.readLog();
      check(
        'instance log shows the shutdown stop and its force-kill',
        instanceLog.includes('[squash] stopping: SIGHUP') && instanceLog.includes('stop timed out after 2000ms; force-killing'),
        tail(instanceLog)
      );
    }
    if (orphan && isAlive(orphan.pid)) {
      try { process.kill(-orphan.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    // Handled: by cleanup time its PID may belong to another process.
    orphan = undefined;
    const after = await tcpProbe('127.0.0.1', port);
    check('port released after exit', after !== 'connected', after);
  }

  // --- 2. Strong password + HOST=0.0.0.0 listens on all interfaces -----------------
  {
    const strongPort = await freePort();
    const strongPassword = crypto.randomBytes(18).toString('hex');
    writeEnv(strongPort, (text) => `${text.replace(/^AUTH_PASSWORD=.*$/m, `AUTH_PASSWORD=${strongPassword}`)}\nHOST=0.0.0.0\n`);
    log('checking that a strong password + HOST=0.0.0.0 listens on all interfaces');
    const open = launch();
    serverLogs.push(['strong password + HOST=0.0.0.0', open]);
    const line = await waitForListening(open);
    check('strong password + HOST=0.0.0.0 binds 0.0.0.0', line?.host === '0.0.0.0', line ? `host=${line.host}` : `output: ${tail(open.output(), 1500)}`);
    if (line && lanAddress) {
      const viaLan = await api(strongPort, 'GET', '/api/health', { host: lanAddress }).catch((err: Error) => ({ status: err.message }));
      check(`reachable via LAN address ${lanAddress}`, viaLan.status === 200, `status=${viaLan.status}`);
    }
    const openResult = await terminate(open);
    if (!isWindows) {
      check('with no instances the launcher exits 0 too', openResult.code === 0, `code=${openResult.code} signal=${openResult.signal}`);
    }
  }

  // --- 3. Weak protection + HOST=0.0.0.0 must not start ---------------------------
  for (const [label, prepare, reason] of refusalCases) {
    const refusePort = await freePort();
    prepare(refusePort);
    log(`checking refusal: ${label} + HOST=0.0.0.0`);
    const refused = launch({ HOST: '0.0.0.0', PORT: String(refusePort) });
    serverLogs.push([`refusal: ${label}`, refused]);
    const outcome = await withTimeout(refused.closed, 30000);
    if (!outcome) forceKill(refused);
    const fatal = findLogLine(refused.output(), (j) => j.level === 60);
    const hint = 'Set AUTH_USERNAME and a strong AUTH_PASSWORD';
    check(
      refusalLabel(label),
      outcome?.code === 1 &&
        Boolean(fatal?.msg?.includes(`Refusing to listen on 0.0.0.0 because ${reason}`) && fatal!.msg.includes(hint)) &&
        !findLogLine(refused.output(), isRunningLine),
      outcome ? `code=${outcome.code} fatal=${JSON.stringify(fatal?.msg ?? null)}` : 'still running after 30s'
    );
  }

  if (sectionError !== undefined) throw sectionError;
};

// Stops whatever is still running and removes the extracted bundle; prints
// the launchers' output when anything failed. A bundle that cannot be
// removed is only logged, as in the smoke.
const cleanup = async ({ failed }: { readonly failed: boolean }): Promise<undefined> => {
  stopping = true;
  // --- Report & cleanup -------------------------------------------------------
  if (anyFailed || failed) {
    for (const [label, proc] of serverLogs) {
      console.log(`[smoke] --- launcher output (${label}) ---\n${proc.output().slice(-4000)}`);
    }
  }
  // Only what the flow left running (it stops every launcher it finishes
  // with). On Windows only a live launcher: taskkill /T on an exited one's
  // PID could hit whatever reuses it; a POSIX group ID stays taken while any
  // of its processes lives.
  for (const [, proc] of serverLogs) {
    const live = !isWindows || (proc.child.exitCode === null && proc.child.signalCode === null);
    if (!proc.isClosed && live) {
      forceKill(proc);
      await withTimeout(proc.closed, 5000);
    }
  }
  if (orphan && isAlive(orphan.pid)) {
    try { process.kill(-orphan.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  if (!workRoot) return undefined;
  try {
    fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (err) {
    log(`could not remove ${workRoot}: ${(err as Error).message}`);
  }
  return undefined;
};

run(flow, { timeoutMs: FLOW_TIMEOUT_MS, cleanup });
