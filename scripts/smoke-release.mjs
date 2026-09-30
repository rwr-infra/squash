// Smoke-tests the FINAL release archive for the current platform/arch, the way a
// user would run it: extract into a path with spaces, parentheses, `&` and
// non-ASCII characters, strip every `node` from PATH, copy .env.example to .env,
// and start the bundle through its launcher (start.sh / start.bat). Checks:
//   - the archive ships no .env; the bundled runtime runs and matches
//     build-info.json; the frontend has no dev API origin baked in
//   - default config listens on loopback only (probed from a LAN address too)
//   - GET /api/health, GET / (frontend), login admin/admin, 401 without token
//   - a shell instance round-trips PTY input/output in both directions:
//     WebSocket input → WebSocket output, and the command-capture endpoint
//   - stopping the instance ends in `stopped` (not `crashed`)
//   - terminating the LAUNCHER stops the server and frees the port
//   - a strong password + HOST=0.0.0.0 listens on all interfaces
//   - weak protection + HOST=0.0.0.0 is refused (default password written in
//     .env, credentials unset, auth disabled) with the operator hint and no
//     listen
//
// Usage: node scripts/smoke-release.mjs [path/to/archive]
// Default archive: release/squash-<version>-<platform>-<arch>.(zip|tar.gz)

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { tarCommand } from './node-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);
const isWindows = process.platform === 'win32';

const log = (msg) => console.log(`[smoke] ${msg}`);
const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms) => Promise.race([promise, sleep(ms).then(() => undefined)]);
const tail = (text, n = 600) => JSON.stringify(text.slice(-n));
// ConPTY and shells emit cursor/colour sequences that could split a marker.
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

// --- Locate & extract ---------------------------------------------------------
const defaultArchive = () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  return path.join(rootDir, 'release', `squash-${version}-${process.platform}-${process.arch}.${isWindows ? 'zip' : 'tar.gz'}`);
};
const archive = path.resolve(process.argv[2] ?? defaultArchive());
if (!fs.existsSync(archive)) {
  console.error(`[smoke] archive not found: ${archive} — run \`npm run package\` first.`);
  process.exit(1);
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-smoke-'));
// Parentheses guard start.bat against "Program Files (x86)"-style paths; `&` is
// a cmd metacharacter; the CJK part exercises non-ASCII handling. No `%`: cmd
// would expand it.
const appDir = path.join(workRoot, 'squash smoke (x86) & 测试');
fs.mkdirSync(appDir);
log(`extracting ${path.basename(archive)} → ${appDir}`);
// Pass the destination as cwd, not `-C`: Windows' bsdtar converts argv through
// the ANSI code page, which mangles non-ASCII paths (libarchive#2092); cwd goes
// through the Unicode CreateProcessW path.
execFileSync(tarCommand(), ['-xf', archive], { cwd: appDir, stdio: 'inherit' });

// --- Static checks on the extracted bundle -----------------------------------
check('archive ships no .env', !fs.existsSync(path.join(appDir, '.env')));

const buildInfo = JSON.parse(fs.readFileSync(path.join(appDir, 'build-info.json'), 'utf8'));
if (!process.argv[2]) {
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
  runtimeVersion = `failed: ${err.message}`;
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
const removedDirs = [];
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

const baseEnv = { ...process.env };
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

// --- Helpers ------------------------------------------------------------------
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// 'connected' | error code (e.g. ECONNREFUSED) | 'timeout'
const tcpProbe = (host, port, ms = 3000) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(ms, () => done('timeout'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (err) => done(err.code ?? err.message));
  });

// A non-loopback IPv4 address of this machine, to prove what a loopback bind
// really excludes. Undefined when the host has none (then those probes skip).
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((addr) => addr && addr.family === 'IPv4' && !addr.internal)?.address;
if (!lanAddress) log('no non-loopback IPv4 address found — LAN reachability probes will be skipped');

const template = fs.readFileSync(path.join(appDir, '.env.example'), 'utf8');
check('.env.example does not set HOST', !/^\s*HOST\s*=/m.test(template));
const envFile = path.join(appDir, '.env');
const writeEnv = (port, edit = (text) => text) =>
  fs.writeFileSync(envFile, edit(template.replace(/^PORT=.*$/m, `PORT=${port}`)));

const launch = (extraEnv = {}) => {
  const env = { ...baseEnv, ...extraEnv };
  // Start from an unrelated cwd: the launcher itself must cd into the bundle.
  // POSIX: own process group, so cleanup can kill whatever the launcher left.
  const opts = { cwd: workRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows };
  // `cmd /s /c` strips ONE outer pair of quotes, so a path with spaces needs
  // two: ""C:\...\start.bat"". Verbatim args keep Node from re-quoting it.
  const child = isWindows
    ? spawn('cmd.exe', ['/d', '/s', '/c', `""${path.join(appDir, 'start.bat')}""`], { ...opts, windowsVerbatimArguments: true })
    : spawn(path.join(appDir, 'start.sh'), [], opts);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (s) => { output += s; });
  child.stderr.on('data', (s) => { output += s; });
  child.on('error', (err) => { output += `\n[smoke] spawn error: ${err.message}\n`; });
  const proc = { child, output: () => output, isClosed: false };
  // 'close', not 'exit': it fires only once every holder of the stdio pipes is
  // gone, so a server orphaned by its launcher keeps it pending.
  proc.closed = new Promise((resolve) => child.on('close', (code, signal) => { proc.isClosed = true; resolve({ code, signal }); }));
  return proc;
};

const forceKill = (proc) => {
  if (isWindows) {
    try { execFileSync('taskkill', ['/pid', String(proc.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else {
    try { process.kill(-proc.child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
};

// Terminates the launcher the way an operator or service manager would (the
// launcher PID only — on POSIX start.sh must `exec` node for this to work) and
// reports whether everything exited. Always cleans up afterwards.
const terminate = async (proc) => {
  if (proc.isClosed) return true;
  if (isWindows) {
    try { execFileSync('taskkill', ['/pid', String(proc.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else {
    try { process.kill(proc.child.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  const exited = Boolean(await withTimeout(proc.closed, 15000));
  if (!exited) {
    forceKill(proc);
    await withTimeout(proc.closed, 5000);
  }
  return exited;
};

const findLogLine = (text, predicate) => {
  for (const line of text.split(/\r?\n/)) {
    try {
      const json = JSON.parse(line);
      if (predicate(json)) return json;
    } catch { /* not JSON */ }
  }
  return undefined;
};
const isRunningLine = (j) => j.msg === 'HTTP server running';

const waitFor = async (predicate, timeoutMs, intervalMs = 200) => {
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
const waitForListening = (proc) =>
  waitFor(() => findLogLine(proc.output(), isRunningLine) ?? (proc.isClosed ? 'closed' : undefined), 60000).then(
    (result) => (result && result !== 'closed' ? result : undefined)
  );

const api = async (port, method, url, { token, body, host = '127.0.0.1' } = {}) => {
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
  let json;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
};

const serverLogs = [];

// --- 1. Default config: full user journey --------------------------------------
const port = await freePort();
writeEnv(port);
log(`starting bundle via ${isWindows ? 'start.bat' : 'start.sh'} on port ${port} (.env copied from .env.example)`);
const server = launch();
serverLogs.push(['default config', server]);
const running = await waitForListening(server);

try {
  if (!check('server started', Boolean(running), running ? '' : `output: ${tail(server.output(), 2000)}`)) throw new Error('abort');
  check('logs a loopback bind', running.host === '127.0.0.1', `host=${running.host}`);
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
  const token = loginRes.json?.data?.token;
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

  const wsChunks = [];
  const wsText = () => stripAnsi(wsChunks.join(''));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${instanceId}?token=${encodeURIComponent(token)}`);
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'output') wsChunks.push(msg.data);
    } catch { /* ignore */ }
  };
  const wsOpen = await withTimeout(
    new Promise((resolve) => { ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); }),
    10000
  );
  check('terminal WebSocket connects', Boolean(wsOpen));

  await sleep(1500); // let the shell print its prompt
  const echo = (suffix) => (isWindows ? `echo smoke-%SQUASH_SMOKE%-${suffix}` : `echo smoke-$SQUASH_SMOKE-${suffix}`);

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
  let finalStatus;
  await waitFor(async () => {
    const got = await api(port, 'GET', `/api/instances/${instanceId}`, { token });
    finalStatus = got.json?.data?.runtime?.status;
    return finalStatus === 'stopped' || finalStatus === 'crashed';
  }, 15000, 500);
  check('stopped instance ends in `stopped` (not `crashed`)', finalStatus === 'stopped', `status=${finalStatus}`);
  await api(port, 'DELETE', `/api/instances/${instanceId}`, { token });
} catch (err) {
  if (err.message !== 'abort') check('smoke run', false, err.stack);
} finally {
  check('terminating the launcher stops the server', await terminate(server));
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
    const viaLan = await api(strongPort, 'GET', '/api/health', { host: lanAddress }).catch((err) => ({ status: err.message }));
    check(`reachable via LAN address ${lanAddress}`, viaLan.status === 200, `status=${viaLan.status}`);
  }
  await terminate(open);
}

// --- 3. Weak protection + HOST=0.0.0.0 must not start ---------------------------
const refusalCases = [
  ['password from the copied .env.example', (p) => writeEnv(p), 'the default password (admin) is in use'],
  ['no .env (credentials unset)', () => fs.rmSync(envFile, { force: true }), 'the default password (admin) is in use'],
  ['AUTH_PASSWORD= empty, no token', (p) => writeEnv(p, (t) => t.replace(/^AUTH_PASSWORD=.*$/m, 'AUTH_PASSWORD=')), 'authentication is disabled']
];
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
    `refused (${label}): exit 1, fatal hint, never listened`,
    outcome?.code === 1 &&
      Boolean(fatal?.msg?.includes(`Refusing to listen on 0.0.0.0 because ${reason}`) && fatal.msg.includes(hint)) &&
      !findLogLine(refused.output(), isRunningLine),
    outcome ? `code=${outcome.code} fatal=${JSON.stringify(fatal?.msg ?? null)}` : 'still running after 30s'
  );
}

// --- Report & cleanup -----------------------------------------------------------
if (failures.length) {
  for (const [label, proc] of serverLogs) {
    console.log(`[smoke] --- launcher output (${label}) ---\n${proc.output().slice(-4000)}`);
  }
}
try {
  fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (err) {
  log(`could not remove ${workRoot}: ${err.message}`);
}

if (failures.length) {
  console.error(`[smoke] ${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
log('all checks passed');
// Exit explicitly: pending timers (timeouts that lost their race) must not
// delay the job.
process.exit(0);
