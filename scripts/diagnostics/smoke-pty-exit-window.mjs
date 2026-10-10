// Windows-only bounded ConPTY exit-window investigation. Runs the compiled
// production supervisor in disposable workers; no game server or user config.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.platform, 'win32', 'This smoke requires Windows ConPTY');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node >=24');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const waitFor = async (predicate, label, ms = 15000) => {
  const deadline = Date.now() + ms;
  do { if (predicate()) return; await sleep(5); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
};

const runWorker = async () => {
  const [, , , work, kind, exitMode, sizeText] = process.argv;
  assert(path.resolve(work).startsWith(path.join(root, '.cache/pty-exit-window-')));
  const payloadSize = Number(sizeText);
  assert([64, 8192].includes(payloadSize));
  fs.mkdirSync(work, { recursive: true });
  const childFile = path.join(work, 'child.cjs');
  fs.writeFileSync(childFile, `process.stdout.write('CHILD_READY:'+process.pid+'\\n');let exiting=false;process.stdin.on('data',chunk=>{if(!exiting && chunk.toString().includes('__exit__')){exiting=true;setTimeout(()=>{process.stdout.write('CHILD_EXITING\\n');process.exit(${exitMode === 'one' ? 1 : 0});},200);}});`);
  let childPid, term, rawExitAt, rawExitEvent, goneAt, interval;
  let windowWrites = 0, successfulWindowWrites = 0, windowBytes = 0, output = '';
  const synchronousWriteErrors = [];
  let childWasAlive = false;
  const samples = [];
  const captures = [];
  // Monitor is observational: default Node uncaught exception handling still
  // terminates the worker with a non-zero exit. The probe itself adds no error
  // listeners; the production adapter's tolerated-error filter (attached after
  // spawn since 9513bbf, rethrows non-tolerated errors) is snapshotted as the
  // baseline and asserted to be the only listener at exit.
  process.on('uncaughtExceptionMonitor', error => console.error(`[uncaught] ${error.stack}`));
  const require = createRequire(import.meta.url);
  const nodePty = require('node-pty');
  const nativeSpawn = nodePty.spawn;
  // Install before importing the ESM adapter. Assert that the hook was used.
  nodePty.spawn = (...args) => {
    term = nativeSpawn(...args);
    term.onExit(event => { rawExitAt = Date.now(); rawExitEvent = event; });
    const socket = term._agent?.inSocket;
    assert(socket, 'Installed node-pty exposes the observed ConPTY input socket');
    assert.equal(socket.listenerCount('error'), 0, 'Probe must not hide input socket errors');
    const originalWrite = socket.write;
    socket.write = function (...writeArgs) {
      const inWindow = childPid && !rawExitAt && !alive(childPid);
      if (inWindow) {
        goneAt ??= Date.now();
        windowWrites++;
        const bytes = Buffer.byteLength(writeArgs[0]);
        windowBytes += bytes;
        if (samples.length < 3) samples.push({ elapsedMs: Date.now() - goneAt, bytes });
      }
      try {
        const writeResult = Reflect.apply(originalWrite, this, writeArgs);
        if (inWindow) successfulWindowWrites++;
        return writeResult;
      } catch (error) {
        synchronousWriteErrors.push({ message: error.message, code: error.code, inWindow: Boolean(inWindow) });
        console.error(`[sync-write] ${error.message}`);
        throw error;
      }
    };
    return term;
  };
  const { createInstanceSupervisor } = await import('../../dist/core/instance/instance-supervisor.js');
  const supervisor = await createInstanceSupervisor({ id: 'window-probe', name: 'window-probe', cwd: work, executable: process.execPath, args: [childFile], env: {}, logDir: work, restartPolicy: 'never', stopCommand: `__exit__\n${'x'.repeat(payloadSize)}`, stopTimeoutMs: 5000 });
  supervisor.onData(chunk => { output += chunk; });
  await supervisor.start();
  // Since the input-socket release fix, the production adapter attaches a
  // tolerated-error filter to the input socket right after spawn (9513bbf):
  // it swallows only post-exit pipe errors and RETHROWS everything else, so
  // it hides nothing. Coverage requires no listener BEYOND this production
  // baseline - that would be a probe-added swallower.
  const productionErrorListeners = term._agent.inSocket.listenerCount('error');
  await waitFor(() => /CHILD_READY:(\d+)[\r\n]/.test(output) && supervisor.getRuntime().status === 'running', 'child ready');
  childPid = Number(/CHILD_READY:(\d+)[\r\n]/.exec(output)[1]);
  assert(term, 'Production adapter used real instrumented node-pty spawn');
  assert.equal(term.pid, childPid, 'Raw PTY PID matches the complete child ready marker');
  assert(alive(childPid), 'Child was independently alive before exit');
  childWasAlive = true;
  const payload = 'x'.repeat(payloadSize);
  if (kind === 'stop') supervisor.stop();
  else {
    if (exitMode === 'forced') process.kill(childPid, 'SIGKILL');
    else supervisor.sendCommand('__exit__');
    interval = setInterval(() => {
      if (rawExitAt || alive(childPid)) return;
      goneAt ??= Date.now();
      assert.equal(supervisor.getRuntime().status, 'running', 'Input occurs while production supervisor still considers child running');
      if (kind === 'command') supervisor.sendCommand(payload);
      else if (kind === 'raw') supervisor.sendRawInput(`${payload}\r`);
      else if (kind === 'capture') captures.push(supervisor.captureCommand(payload, { captureMs: 25 }));
      else throw new Error(`Unknown probe kind: ${kind}`);
    }, 5);
  }
  await waitFor(() => Boolean(rawExitAt), 'real PTY exit');
  clearInterval(interval);
  await waitFor(() => ['stopped', 'crashed'].includes(supervisor.getRuntime().status), 'supervisor settles');
  await Promise.all(captures);
  const runtime = supervisor.getRuntime();
  assert.equal(synchronousWriteErrors.length, 0, 'Synchronous socket write errors must not be counted as a pass');
  assert(goneAt && windowWrites > 0 && windowBytes > 0, 'Real socket writes must occur after independent child disappearance and before PTY exit');
  assert(successfulWindowWrites > 0, 'A real window write must return without a synchronous exception');
  assert(!alive(childPid), 'Child is gone at completion');
  if (kind === 'stop' || exitMode === 'zero') assert.equal(runtime.status, 'stopped');
  else assert.equal(runtime.status, 'crashed');
  if (exitMode !== 'forced') assert.equal(rawExitEvent.exitCode, exitMode === 'one' ? 1 : 0);
  assert.equal(runtime.exitCode, rawExitEvent.exitCode);
  assert.equal(runtime.pid, undefined);
  await supervisor.dispose();
  // Pending writes are diagnostic evidence, not a safe pass. Preserve the
  // non-zero outcome instead of reducing pressure until this becomes green.
  let queueDrainedWithinBudget = false;
  try { await waitFor(() => term._agent.inSocket.writableLength === 0, 'input write queue drains', 2000); queueDrainedWithinBudget = true; }
  catch (error) { if (!error.message.startsWith('Timed out: input write queue drains')) throw error; }
  const queuedInputBytesAtBudget = term._agent.inSocket.writableLength;
  // Include a bounded drain for asynchronous errors after onExit. Explicit
  // worker exit is intentional: node-pty may retain the input handle.
  await sleep(500);
  const queuedInputBytes = term._agent.inSocket.writableLength;
  const verdict = queueDrainedWithinBudget ? 'no-error-observed' : 'inconclusive-pending-input';
  console.log(JSON.stringify({ kind: 'pty-window-result', operation: kind, exitMode, payloadSize, childPid, childWasAlive, windowWrites, successfulWindowWrites, synchronousWriteErrors, windowBytes, windowMs: rawExitAt - goneAt, rawExitEvent, finalStatus: runtime.status, samples, productionErrorListeners, inputErrorListeners: term._agent.inSocket.listenerCount('error'), inputErrorListenersBeyondProduction: term._agent.inSocket.listenerCount('error') - productionErrorListeners, queueDrainedWithinBudget, queuedInputBytesAtBudget, queuedInputBytes, postExitDrainMs: 500, queueDrainBudgetMs: 2000, verdict }));
  return queueDrainedWithinBudget ? 0 : 2;
};

if (process.argv[2] === '--worker') {
  try { process.exit(await runWorker()); }
  catch (error) { console.error(error.stack); process.exit(1); }
} else {
  assert(fs.existsSync(path.join(root, 'dist/core/instance/instance-supervisor.js')), 'Build server first');
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  const work = fs.mkdtempSync(path.join(root, '.cache/pty-exit-window-'));
  const configFile = path.join(root, 'config/instances.json');
  const configFingerprint = () => fs.existsSync(configFile) ? crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex') : 'absent';
  const originalConfig = configFingerprint();
  const productionFiles = ['src/core/pty/pty-process-adapter.ts', 'src/core/instance/instance-supervisor.ts'];
  const productionFingerprint = () => Object.fromEntries(productionFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  const originalProduction = productionFingerprint();
  const fixturePids = () => {
    const needle = work.replaceAll("'", "''");
    const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $taskProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.CommandLine.Contains('child.cjs') }); ConvertTo-Json -InputObject @($taskProcesses | ForEach-Object { [int]$_.ProcessId }) -Compress`;
    const result = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, `Independent fixture inventory failed: ${result.stderr}`);
    return JSON.parse(result.stdout.trim());
  };
  const results = [];
  const scenarios = ['command', 'raw', 'capture'].flatMap(kind => ['zero', 'one', 'forced'].map(exitMode => ({ kind, exitMode, size: exitMode === 'zero' ? 64 : 8192 })));
  scenarios.push({ kind: 'stop', exitMode: 'zero', size: 64 }, { kind: 'stop', exitMode: 'zero', size: 8192 });
  let failed = false, cleanupError;
  try {
    for (const [index, scenario] of scenarios.entries()) {
      const scenarioDir = path.join(work, `case-${index}`);
      const child = spawn(process.execPath, ['--unhandled-rejections=strict', fileURLToPath(import.meta.url), '--worker', scenarioDir, scenario.kind, scenario.exitMode, String(scenario.size)], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      }, 25000);
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
      const result = stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(item => item?.kind === 'pty-window-result');
      results.push({ scenario, ...exit, result, stdout, stderr });
      assert([0, 2].includes(exit.code), `${scenario.kind}/${scenario.exitMode}: unexpected exit ${exit.code}: ${stderr}`);
      assert(result?.windowWrites > 0 && result.childWasAlive && result.inputErrorListenersBeyondProduction === 0, 'No probe-added error handler on the input socket (production filter only)');
      assert(result.successfulWindowWrites > 0 && result.synchronousWriteErrors.length === 0, 'Synchronous write exceptions must fail the probe');
      assert.equal(exit.code, result.queueDrainedWithinBudget ? 0 : 2, 'Exceeding the queue budget must remain a non-zero diagnostic result');
      console.log(`[pty-window] ${exit.code === 0 ? 'PASS' : 'INCONCLUSIVE'} ${scenario.kind}/${scenario.exitMode}/${scenario.size}: ${result.windowWrites} socket writes, ${result.windowBytes} bytes, window ${result.windowMs}ms, pending ${result.queuedInputBytes} bytes`);
    }
    assert.equal(fixturePids().length, 0, 'Independent scan must find no fixture children');
  } catch (error) { failed = true; console.error(error.stack); }
  finally {
    try {
      for (const pid of fixturePids()) spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      assert.equal(fixturePids().length, 0, 'Fixture cleanup must remove every matching child');
      assert.equal(path.dirname(path.resolve(work)), path.join(root, '.cache'));
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) { cleanupError = error.message; failed = true; console.error(`Cleanup failed: ${cleanupError}`); }
    const userConfigUnchanged = configFingerprint() === originalConfig;
    const productionAfter = productionFingerprint();
    const productionUnchanged = JSON.stringify(productionAfter) === JSON.stringify(originalProduction);
    if (!userConfigUnchanged || !productionUnchanged) failed = true;
    const nodePtyVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/node-pty/package.json'))).version;
    const inconclusive = results.filter(item => item.code === 2).length;
    fs.writeFileSync(path.join(root, '.cache/pty-exit-window-evidence.json'), JSON.stringify({ node: process.version, platform: process.platform, nodePty: nodePtyVersion, failed, inconclusive, cleanupError, fixtureCleaned: !fs.existsSync(work), userConfigUnchanged, productionUnchanged, originalProduction, productionAfter, results }, null, 2));
    console.log(`[pty-window] ${results.filter(item => item.code === 0).length} PASS, ${inconclusive} INCONCLUSIVE / ${scenarios.length}; failed=${failed}`);
    process.exitCode = failed ? 1 : inconclusive > 0 ? 2 : 0;
  }
}
