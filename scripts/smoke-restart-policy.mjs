// Real HTTP/WS + compiled manager + node-pty regression. Build server/web first.
// Copies build output into a workspace-local temporary app; never copies or
// edits the checkout's config. Requires Node >=24 (native WebSocket).
// Windows shutdown is requested over IPC and emits the actual entry point's
// SIGTERM event: this tests shutdown handling, not OS signal delivery.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node >=24');
assert(fs.existsSync(path.join(root, 'dist/index.js')), 'Run build:server first');
assert(fs.existsSync(path.join(root, 'frontend/dist/index.html')), 'Build frontend first');
const cache = path.join(root, '.cache');
fs.mkdirSync(cache, { recursive: true });
const workRoot = fs.mkdtempSync(path.join(cache, 'restart-policy-e2e-'));
const appDir = path.join(workRoot, 'app');
fs.mkdirSync(appDir);
fs.cpSync(path.join(root, 'dist'), path.join(appDir, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'frontend/dist'), path.join(appDir, 'frontend/dist'), { recursive: true });
fs.writeFileSync(path.join(appDir, 'package.json'), '{"type":"module"}');
const originalConfig = path.join(root, 'config/instances.json');
const configFingerprint = () => fs.existsSync(originalConfig)
  ? crypto.createHash('sha256').update(fs.readFileSync(originalConfig)).digest('hex') : 'absent';
const originalFingerprint = configFingerprint();
const checks = [];
const sockets = new Set();
const observedPids = new Set();
let manager;
let token;
let port;
let failed = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (label, condition, detail = '') => {
  checks.push({ label, passed: Boolean(condition), detail });
  console.log(`[e2e] ${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  assert(condition, label);
};
const within = async (promise, ms) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
};
const waitFor = async (predicate, ms = 15000) => {
  const deadline = Date.now() + ms;
  do {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Condition not met within ${ms}ms`);
};
const isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const forceKill = pid => {
  if (!pid || !isAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
};
// Independent of runtime/onExit: identify only this run's unique fake-child
// command line. Never kill historical PIDs, which Windows may have recycled.
const fixturePids = () => {
  if (process.platform === 'win32') {
    const needle = childFile.replaceAll("'", "''");
    const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $taskProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') }); ConvertTo-Json -InputObject @($taskProcesses | ForEach-Object { [int]$_.ProcessId }) -Compress`;
    const result = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, `Fixture process inventory failed: ${result.stderr}`);
    return JSON.parse(result.stdout.trim());
  }
  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `Fixture process inventory failed: ${result.stderr}`);
  return result.stdout.split('\n').filter(line => line.includes(childFile)).map(line => Number(/^\s*(\d+)/.exec(line)?.[1])).filter(pid => Number.isInteger(pid) && pid > 0);
};
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port: chosen } = server.address();
    server.close(() => resolve(chosen));
  });
});
const request = async (method, route, body, expected = 200) => {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
};
const get = async id => (await request('GET', `/instances/${id}`)).data;
const runtimeMatching = (id, predicate, ms) => waitFor(async () => {
  const { runtime } = await get(id);
  return predicate(runtime) ? runtime : undefined;
}, ms);
const boots = id => {
  try { return Number(fs.readFileSync(path.join(workRoot, id, 'boots'), 'utf8')); } catch { return 0; }
};
const childFile = path.join(workRoot, 'fake-rwr.cjs');
fs.writeFileSync(childFile, `
const fs = require('node:fs');
const mode = process.argv[2];
const boot = Number(fs.existsSync('boots') ? fs.readFileSync('boots', 'utf8') : 0) + 1;
fs.writeFileSync('boots', String(boot));
console.log('ready boot=' + boot + ' pid=' + process.pid);
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  const lines = (pending + data).split(/\\r?\\n/);
  pending = lines.pop();
  for (const line of lines) {
    if (line === 'clean') { console.log('An exception has occurred!\\nbad allocation'); process.exit(0); }
    if (line === 'failed') process.exit(1);
    if (line === 'quit') { console.log('quit accepted'); process.exit(0); }
  }
});
if (mode === 'clean-loop' || (mode === 'clean-once' && boot === 1)) setTimeout(() => process.exit(0), 250);
setInterval(() => {}, 1000);
`);
const launcher = path.join(appDir, 'e2e-launch.mjs');
fs.writeFileSync(launcher, `
process.on('message', message => {
  if (message === 'shutdown') {
    if (!process.listenerCount('SIGTERM')) throw new Error('Manager has no shutdown handler');
    process.emit('SIGTERM', 'SIGTERM');
  }
});
await import('./dist/index.js');
`);
const launch = async () => {
  port = await freePort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AUTH_|SQUASH_|HOST$|PORT$|LOG_LEVEL$|NODE_OPTIONS$|NODE_ENV$)/i.test(key)) delete env[key];
  }
  Object.assign(env, { HOST: '127.0.0.1', PORT: String(port), AUTH_USERNAME: 'admin', AUTH_PASSWORD: 'admin', NODE_ENV: 'production' });
  const child = spawn(process.execPath, [launcher], { cwd: appDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  let closed = false;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
  });
  manager = { child, ended, output: () => output, isClosed: () => closed };
  await waitFor(async () => {
    if (closed) throw new Error(`Manager exited: ${output}`);
    try { return (await request('GET', '/health')).success; } catch { return false; }
  }, 30000);
  token = (await request('POST', '/auth/login', { username: 'admin', password: 'admin' })).data.token;
};
const shutdown = async (label, runningSnapshot) => {
  const current = manager;
  const running = runningSnapshot ?? fixturePids();
  if (label === 'final') check('final shutdown has independently observed live fixture', running.length > 0 && running.every(pid => observedPids.has(pid)));
  current.child.send('shutdown');
  const result = await within(current.ended, 15000);
  check(`${label}: actual manager shutdown exits 0`, result.code === 0 && current.output().includes('Shutdown complete'));
  check(`${label}: independently enumerated fixture processes are gone`, running.every(pid => !isAlive(pid)) && fixturePids().length === 0);
  await waitFor(() => [...sockets].every(socket => socket.readyState === WebSocket.CLOSED), 5000);
  check(`${label}: WebSocket sessions close`, true);
  sockets.clear();
  const released = await new Promise(resolve => {
    const probe = net.connect({ host: '127.0.0.1', port });
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => { probe.destroy(); resolve(true); });
    probe.setTimeout(2000, () => { probe.destroy(); resolve(false); });
  });
  check(`${label}: port released`, released);
};
const connect = async id => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${id}?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  const messages = [];
  let childOutput = '';
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    if (message.type === 'output') {
      childOutput += message.data;
      for (const match of childOutput.matchAll(/ready boot=\d+ pid=(\d+)/g)) observedPids.add(Number(match[1]));
    }
  });
  await within(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  }), 10000);
  await waitFor(() => messages.find(message => message.type === 'runtime'));
  return {
    messages,
    childPids: () => Array.from(childOutput.matchAll(/ready boot=\d+ pid=(\d+)/g), match => Number(match[1])),
    runtime: predicate => waitFor(() => messages.find(message => message.type === 'runtime' && predicate(message))),
    ready: boot => waitFor(() => messages.filter(message => message.type === 'output').map(message => message.data).join('').includes(`ready boot=${boot} `))
  };
};
const config = (id, policy, { mode = 'controlled', ...extra } = {}) => {
  const cwd = path.join(workRoot, id);
  fs.mkdirSync(cwd, { recursive: true });
  return {
    id, name: id, cwd, executable: process.execPath, args: [childFile, mode],
    logDir: path.join(appDir, 'logs'), restartDelayMs: 1200,
    stopCommand: 'quit', stopTimeoutMs: 3000,
    ...(policy === undefined ? {} : { restartPolicy: policy }), ...extra
  };
};
const create = async body => { await request('POST', '/instances', body, 201); return body; };
const command = (id, value) => request('POST', `/instances/${id}/command`, { command: value });
const startReady = async (id, viewer, boot = 1) => {
  await request('POST', `/instances/${id}/start`);
  await viewer.ready(boot);
};
const stop = async id => {
  await request('POST', `/instances/${id}/stop`);
  await runtimeMatching(id, runtime => runtime.status === 'stopped' && runtime.desiredState === 'stopped');
};

try {
  console.log(`[e2e] Node ${process.version}; isolated app ${appDir}`);
  await launch();
  const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(15000) });
  const html = await page.text();
  check('manager serves the built frontend HTML', page.status === 200 && html.includes('<div id="root"'));
  const asset = html.match(/src="([^"]+\.js)"/);
  assert(asset, 'Frontend script asset missing');
  const bundle = await fetch(new URL(asset[1], `http://127.0.0.1:${port}`), { signal: AbortSignal.timeout(15000) });
  const bundleText = await bundle.text();
  check('served frontend includes restart selection and recovery status', bundle.status === 200 && bundleText.includes('Keep running (recommended for RWR)') && bundleText.includes('Auto-restart paused after 5 attempts'));
  const history = await fetch(`http://127.0.0.1:${port}/terminal/e2e`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
  check('terminal browser route serves the SPA shell', history.status === 200 && (await history.text()).includes('<div id="root"'));
  const persisted = [];
  for (const policy of ['never', 'on-failure', 'always']) persisted.push(await create(config(`saved-${policy}`, policy)));
  persisted.push(await create(config('legacy-enabled', undefined, { autoRestart: true })));
  persisted.push(await create(config('legacy-disabled', undefined, { autoRestart: false })));
  const disk = JSON.parse(fs.readFileSync(path.join(appDir, 'config/instances.json'), 'utf8'));
  check('HTTP create persists every restart policy', persisted.every(body => disk.find(row => row.id === body.id)?.restartPolicy === body.restartPolicy));
  await request('POST', '/instances', config('invalid-policy', 'sometimes'), 400);
  check('invalid HTTP policy never reaches disk', !JSON.parse(fs.readFileSync(path.join(appDir, 'config/instances.json'), 'utf8')).some(row => row.id === 'invalid-policy'));
  const edited = { ...persisted[0], restartPolicy: 'always', autoRestart: false };
  await request('PUT', `/instances/${edited.id}`, edited);
  const savedNever = await create(config('saved-never-copy', 'never'));
  check('HTTP edit persists explicit policy over legacy false', JSON.parse(fs.readFileSync(path.join(appDir, 'config/instances.json'), 'utf8')).find(row => row.id === edited.id)?.restartPolicy === 'always');
  await shutdown('reload');
  await launch();
  check('new manager reloads edited policy from JSON', (await get(edited.id)).config.restartPolicy === 'always' && (await get(edited.id)).config.autoRestart === false);
  check('new manager reloads never policy from JSON', (await get(savedNever.id)).config.restartPolicy === 'never');
  for (const body of persisted.slice(1)) {
    const reloaded = (await get(body.id)).config;
    check(`new manager reloads ${body.id}`, reloaded.restartPolicy === body.restartPolicy && (body.autoRestart === undefined || reloaded.autoRestart === body.autoRestart));
  }

  const always = await create(config('always-recovery', 'always', { autoRestart: false }));
  const viewer = await connect(always.id);
  check('initial WS runtime contains identity and desired state', viewer.messages[0].id === always.id && viewer.messages[0].desiredState === 'stopped');
  await startReady(always.id, viewer);
  await command(always.id, 'clean');
  const pending = await viewer.runtime(runtime => runtime.exitCode === 0 && runtime.restartAt);
  check('WS announces zero-code recovery with full runtime', pending.status === 'stopped' && pending.restartCount === 1 && pending.restartReason === 'unexpected-exit' && pending.desiredState === 'running');
  await viewer.ready(2);
  const recovered = await runtimeMatching(always.id, runtime => runtime.status === 'running' && runtime.restartCount === 1);
  const stableStartedAt = new Date(recovered.startedAt).getTime();
  check('HTTP confirms zero-code recovery', boots(always.id) === 2);
  await viewer.runtime(runtime => runtime.status === 'running' && runtime.restartCount === 1);
  let stabilityError;
  const stabilityCheck = waitFor(async () => {
    const { runtime } = await get(always.id);
    assert.equal(runtime.startedAt, recovered.startedAt, 'Stable run unexpectedly replaced');
    assert.equal(runtime.status, 'running');
    if (Date.now() - stableStartedAt < 60000) assert.equal(runtime.restartCount, 1, 'Counter reset before 60 seconds');
    return runtime.restartCount === 0 ? runtime : undefined;
  }, 65000).catch(error => { stabilityError = error; });

  const onFailure = await create(config('on-failure-recovery', 'on-failure', { autoRestart: false }));
  const failureViewer = await connect(onFailure.id);
  await startReady(onFailure.id, failureViewer);
  await command(onFailure.id, 'clean');
  await failureViewer.runtime(runtime => runtime.restartReason === 'clean-exit' && runtime.exitCode === 0);
  await sleep(1600);
  check('on-failure leaves clean completion stopped', boots(onFailure.id) === 1 && !(await get(onFailure.id)).runtime.restartAt);
  await startReady(onFailure.id, failureViewer, 2);
  await command(onFailure.id, 'failed');
  await failureViewer.runtime(runtime => runtime.exitCode === 1 && runtime.restartAt);
  await failureViewer.ready(3);
  check('on-failure restarts non-zero exit over legacy false', boots(onFailure.id) === 3);
  await stop(onFailure.id);

  const never = await create(config('never-recovery', 'never', { autoRestart: true }));
  const neverViewer = await connect(never.id);
  await startReady(never.id, neverViewer);
  await command(never.id, 'failed');
  await neverViewer.runtime(runtime => runtime.exitCode === 1 && runtime.restartReason === 'disabled');
  await sleep(1600);
  check('never overrides legacy true and does not restart failure', boots(never.id) === 1 && !(await get(never.id)).runtime.restartAt);
  await startReady(never.id, neverViewer, 2);
  await command(never.id, 'clean');
  await runtimeMatching(never.id, runtime => runtime.status === 'stopped' && runtime.exitCode === 0 && runtime.restartReason === 'disabled');
  await sleep(1600);
  check('never also leaves zero-code exit stopped', boots(never.id) === 2 && !(await get(never.id)).runtime.restartAt);

  for (const id of ['legacy-enabled', 'legacy-disabled']) {
    const legacyViewer = await connect(id);
    await startReady(id, legacyViewer);
    await command(id, 'clean');
    await runtimeMatching(id, runtime => runtime.status === 'stopped' && runtime.exitCode === 0 && !runtime.restartAt);
    await sleep(1600);
    check(`${id}: clean exit does not restart`, boots(id) === 1);
    await startReady(id, legacyViewer, 2);
    await command(id, 'failed');
    if (id === 'legacy-enabled') {
      await legacyViewer.ready(3);
      check('legacy true still recovers non-zero exit', boots(id) === 3 && (await get(id)).runtime.restartCount === 1);
      await stop(id);
    } else {
      await runtimeMatching(id, runtime => runtime.status === 'crashed' && runtime.exitCode === 1 && !runtime.restartAt);
      await sleep(1600);
      check('legacy false leaves non-zero exit stopped', boots(id) === 2);
    }
  }

  for (const action of ['stop', 'edit', 'delete']) {
    const body = await create(config(`pending-${action}`, 'always', { mode: 'clean-once', restartDelayMs: 3000 }));
    const pendingViewer = await connect(body.id);
    await startReady(body.id, pendingViewer);
    await pendingViewer.runtime(runtime => runtime.restartAt && runtime.exitCode === 0);
    if (action === 'stop') await stop(body.id);
    if (action === 'edit') await request('PUT', `/instances/${body.id}`, { ...body, restartPolicy: 'never' });
    if (action === 'delete') await request('DELETE', `/instances/${body.id}`);
    await sleep(3400);
    check(`HTTP ${action} cancels pending restart`, boots(body.id) === 1);
    if (action === 'stop') {
      await pendingViewer.runtime(runtime => runtime.desiredState === 'stopped' && !runtime.restartAt && runtime.restartReason === 'manual-stop');
      check('WS exposes Stop cancellation', (await get(body.id)).runtime.restartCount === 0);
    }
    if (action === 'edit') check('edited instance has fresh stopped runtime', (await get(body.id)).runtime.desiredState === 'stopped' && (await get(body.id)).config.restartPolicy === 'never');
    if (action === 'delete') await request('GET', `/instances/${body.id}`, undefined, 404);
  }

  const capped = await create(config('backoff-cap', 'always', { mode: 'clean-once', restartDelayMs: 65000 }));
  const capViewer = await connect(capped.id);
  await startReady(capped.id, capViewer);
  const capRuntime = await capViewer.runtime(runtime => runtime.restartAt);
  const planned = new Date(capRuntime.restartAt) - new Date(capRuntime.stoppedAt);
  const capHttp = (await get(capped.id)).runtime;
  check('HTTP and WS expose the same capped recovery schedule', ['restartAt', 'restartCount', 'exitCode', 'restartReason', 'desiredState'].every(key => capHttp[key] === capRuntime[key]));
  const schedulingDelay = await waitFor(() => {
    const log = fs.readFileSync(path.join(capped.logDir, `${capped.id}.log`), 'utf8');
    return /scheduling auto-restart #1 in (\d+)ms/.exec(log);
  });
  // The logged budget is exact; stoppedAt precedes scheduling/broadcast by a
  // small synchronous interval, so the public deadline gets only 25ms slack.
  check('planned backoff uses exactly 60000ms for a 65-second base', Number(schedulingDelay[1]) === 60000 && planned >= 60000 && planned <= 60025, `budget=${schedulingDelay[1]}ms deadlineDelta=${planned}ms`);
  await stop(capped.id);

  const loop = await create(config('retry-limit', 'always', { mode: 'clean-loop', restartDelayMs: 20 }));
  const loopViewer = await connect(loop.id);
  await startReady(loop.id, loopViewer);
  await runtimeMatching(loop.id, runtime => runtime.restartReason === 'retry-limit', 30000);
  const paused = await loopViewer.runtime(runtime => runtime.restartReason === 'retry-limit');
  check('HTTP/WS pauses after exactly five retries', boots(loop.id) === 6 && paused.restartCount === 5 && !paused.restartAt);
  const pausedHttp = (await get(loop.id)).runtime;
  check('HTTP paused runtime matches WS fields', ['restartCount', 'restartAt', 'restartReason', 'exitCode', 'desiredState'].every(key => pausedHttp[key] === paused[key]));
  const lateViewer = await connect(loop.id);
  check('late WS viewer receives full paused state', ['id', 'status', 'restartReason', 'exitCode', 'restartCount', 'desiredState', 'restartAt'].every(key => lateViewer.messages[0][key] === pausedHttp[key]));

  if (process.platform === 'win32') {
    const watched = await create(config('watchdog-always', 'always', { autoRestart: false }));
    const dump = path.join(watched.cwd, 'rwr_crashdump.dmp');
    fs.writeFileSync(dump, 'stale simulated dump');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(dump, old, old);
    const watchedViewer = await connect(watched.id);
    await startReady(watched.id, watchedViewer);
    const watchedPid = watchedViewer.childPids().at(-1);
    assert(Number.isInteger(watchedPid) && fixturePids().includes(watchedPid), 'Watchdog fixture PID not independently observed');
    await sleep(5500);
    check('Windows watchdog ignores stale dump', boots(watched.id) === 1 && (await get(watched.id)).runtime.status === 'running');
    fs.writeFileSync(dump, 'fresh simulated dump');
    await watchedViewer.runtime(runtime => runtime.restartAt && runtime.exitCode !== 0);
    await watchedViewer.ready(2);
    check('Windows fresh dump force-kills and recovers with explicit always', boots(watched.id) === 2 && (await get(watched.id)).runtime.status === 'running');
    check('Windows watchdog old fixture PID is independently gone', !fixturePids().includes(watchedPid));
    await stop(watched.id);

    const unwatched = await create(config('watchdog-never', 'never', { autoRestart: true }));
    const unwatchedViewer = await connect(unwatched.id);
    await startReady(unwatched.id, unwatchedViewer);
    fs.writeFileSync(path.join(unwatched.cwd, 'rwr_crashdump.dmp'), 'fresh simulated dump');
    await sleep(5500);
    check('Windows never policy disables dump watchdog over legacy true', boots(unwatched.id) === 1 && (await get(unwatched.id)).runtime.status === 'running');
    await stop(unwatched.id);
  }

  await stabilityCheck;
  if (stabilityError) throw stabilityError;
  await viewer.runtime(runtime => runtime.status === 'running' && runtime.restartCount === 0 && new Date(runtime.startedAt).getTime() === stableStartedAt);
  check('60 seconds of real stable uptime resets retries via HTTP/WS without an early reset', Date.now() - stableStartedAt >= 60000 && boots(always.id) === 2);
  check('retry breaker remains paused without a residual timer', boots(loop.id) === 6 && (await get(loop.id)).runtime.restartReason === 'retry-limit');
  await command(always.id, 'failed');
  await viewer.ready(3);
  check('always also recovers non-zero exit', boots(always.id) === 3 && (await get(always.id)).runtime.restartCount === 1);

  // WMI can be slow: take the independent snapshot BEFORE opening the short
  // pending-restart window. The final post-exit scan still covers all fixtures.
  const finalRunningPids = fixturePids();
  const exiting = await create(config('shutdown-pending', 'always', { mode: 'clean-once', restartDelayMs: 3000 }));
  const shutdownViewer = await connect(exiting.id);
  await startReady(exiting.id, shutdownViewer);
  await shutdownViewer.runtime(runtime => runtime.restartAt);
  await shutdown('final', finalRunningPids);
  await sleep(3400);
  check('manager shutdown cancels pending zero-code restart', boots(exiting.id) === 1);
  check('checkout user config fingerprint unchanged', configFingerprint() === originalFingerprint);
  console.log(`[e2e] all ${checks.length} checks passed`);
} catch (error) {
  failed = true;
  console.error(error.stack);
  if (manager) console.error(manager.output().slice(-5000));
} finally {
  let cleanupError;
  try {
    for (const socket of sockets) socket.close();
    if (manager && !manager.isClosed()) {
      forceKill(manager.child.pid);
      await within(manager.ended, 5000).catch(() => {});
    }
    for (const pid of fixturePids()) forceKill(pid);
    assert.equal(fixturePids().length, 0, 'Fixture processes remain after cleanup');
    // Keep failure fixtures for diagnosis. Validate the resolved target before
    // recursive deletion: an immediate child of this workspace cache only.
    if (!failed && path.dirname(path.resolve(workRoot)) === path.resolve(cache) && path.basename(workRoot).startsWith('restart-policy-e2e-')) {
      fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  } catch (error) {
    failed = true;
    cleanupError = error.message;
    console.error(`Cleanup failed: ${cleanupError}`);
  }
  const untouched = configFingerprint() === originalFingerprint;
  if (!untouched) { failed = true; console.error('Checkout config fingerprint changed'); }
  fs.writeFileSync(path.join(cache, 'restart-policy-e2e-evidence.json'), JSON.stringify({ node: process.version, checks, failed, cleanupError, fixtureCleaned: !fs.existsSync(workRoot), observedPids: [...observedPids], userConfigUnchanged: untouched, windowsShutdownMethod: 'IPC emits actual manager SIGTERM handler', workRoot }, null, 2));
}
process.exit(failed ? 1 : 0);
