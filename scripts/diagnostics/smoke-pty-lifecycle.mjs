// Windows lifecycle investigation: weak socket references plus parent-side
// OS handle counts. No real server/config, no production resource intervention.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.platform, 'win32', 'Requires Windows ConPTY');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node >=24');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const until = async (test, label, ms = 15000) => {
  const end = Date.now() + ms;
  do { if (test()) return; await sleep(5); } while (Date.now() < end);
  throw new Error(`Timeout: ${label}`);
};
const gcAcrossTurns = async () => { for (let i = 0; i < 3; i++) { await sleep(20); global.gc(); } await sleep(20); };

const worker = async () => {
  const [, , , work, group] = process.argv;
  assert(['control', 'pressure'].includes(group));
  assert(path.resolve(work).startsWith(path.join(root, '.cache/pty-lifecycle-')));
  assert(global.gc && process.send, 'Worker requires --expose-gc and IPC');
  fs.mkdirSync(work, { recursive: true });
  const childFile = path.join(work, 'child.cjs');
  fs.writeFileSync(childFile, "process.stdout.write('READY:'+process.pid+'\\n');let exiting=false;process.stdin.on('data',chunk=>{if(!exiting && chunk.toString().includes('__exit__')){exiting=true;setTimeout(()=>process.exit(0),200);}});");
  process.on('uncaughtExceptionMonitor', error => console.error(`[uncaught] ${error.stack}`));
  const refs = [];
  let current, output = '', generation = 0;
  const require = createRequire(import.meta.url);
  const nodePty = require('node-pty');
  const nativeSpawn = nodePty.spawn;
  nodePty.spawn = (...args) => {
    const term = nativeSpawn(...args);
    const socket = term._agent?.inSocket;
    assert(socket && socket.listenerCount('error') === 0, 'Real unprotected input socket required');
    const state = { generation: ++generation, pid: undefined, exitAt: undefined, writes: 0, bytes: 0, errors: [] };
    current = state;
    refs.push({ generation, socket: new WeakRef(socket), term: new WeakRef(term) });
    term.onExit(() => { state.exitAt = Date.now(); });
    const originalWrite = socket.write;
    socket.write = function (...writeArgs) {
      const inWindow = state.pid && !state.exitAt && !alive(state.pid);
      try {
        const result = Reflect.apply(originalWrite, this, writeArgs);
        if (inWindow) { state.writes++; state.bytes += Buffer.byteLength(writeArgs[0]); }
        return result;
      } catch (error) { state.errors.push(error.message); throw error; }
    };
    return term;
  };
  const { createInstanceSupervisor } = await import('../../dist/core/instance/instance-supervisor.js');
  const supervisor = await createInstanceSupervisor({ id: 'lifecycle', name: 'lifecycle', cwd: work, executable: process.execPath, args: [childFile], env: {}, logDir: work, restartPolicy: 'never', stopCommand: '__exit__', stopTimeoutMs: 3000 });
  supervisor.onData(chunk => { output = (output + chunk).slice(-8192); });
  const snapshot = label => {
    const handles = new Set(process._getActiveHandles());
    const sockets = refs.map(ref => {
      const socket = ref.socket.deref();
      return { generation: ref.generation, collected: !socket, terminalCollected: !ref.term.deref(), active: socket ? handles.has(socket) : false, destroyed: socket?.destroyed, queuedBytes: socket?.writableLength ?? 0 };
    });
    return { label, workerPid: process.pid, gc: true, sockets, activeInputSockets: sockets.filter(item => item.active).length, queuedBytes: sockets.reduce((sum, item) => sum + item.queuedBytes, 0), activeHandles: handles.size, memory: process.memoryUsage() };
  };
  const report = async (label, details = {}) => {
    await gcAcrossTurns();
    const value = { ...snapshot(label), ...details };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { process.off('message', onMessage); reject(new Error('Parent snapshot acknowledgement timed out')); }, 10000);
      const onMessage = message => { if (message?.ack === label) { clearTimeout(timer); process.off('message', onMessage); resolve(); } };
      process.on('message', onMessage);
      process.send({ type: 'snapshot', value });
    });
  };
  await report('baseline');
  const runRound = async index => {
    output = '';
    if (index === 0) await supervisor.start(); else await supervisor.restart();
    await until(() => /READY:(\d+)[\r\n]/.test(output) && supervisor.getRuntime().status === 'running', 'ready');
    const state = current;
    assert(state && state.generation === index + 1);
    state.pid = Number(/READY:(\d+)[\r\n]/.exec(output)[1]);
    assert.equal(refs.at(-1).term.deref()?.pid, state.pid);
    assert(alive(state.pid), 'Complete ready PID must be alive');
    supervisor.sendCommand('__exit__');
    let interval;
    if (group === 'pressure') {
      const payload = 'x'.repeat(8192) + '\r';
      interval = setInterval(() => {
        if (state.exitAt || alive(state.pid)) return;
        assert.equal(supervisor.getRuntime().status, 'running');
        supervisor.sendRawInput(payload);
      }, 5);
    }
    try { await until(() => Boolean(state.exitAt), 'PTY exit'); } finally { clearInterval(interval); }
    await until(() => supervisor.getRuntime().status === 'stopped', 'settled');
    assert(!alive(state.pid), 'Previous child must disappear before restarting');
    assert.equal(supervisor.getRuntime().pid, undefined);
    assert.equal(supervisor.getRuntime().exitCode, 0);
    assert.equal(state.errors.length, 0, 'Synchronous write errors cannot pass');
    if (group === 'pressure') assert(state.writes > 0 && state.bytes > 0, 'Pressure requires real window socket calls');
    else assert.equal(state.writes, 0, 'Control must not write in exit window');
    const details = { generation: state.generation, childPid: state.pid, ptyExitAt: state.exitAt, supervisorExitCode: supervisor.getRuntime().exitCode, synchronousErrors: state.errors.length, windowWrites: state.writes, windowBytes: state.bytes, previousChildGone: true };
    current = undefined;
    return details;
  };
  for (let index = 0; index < 8; index++) { const details = await runRound(index); await report(`round-${index + 1}`, details); }
  await supervisor.dispose();
  await report('disposed');
  await sleep(5000);
  await report('after-5s');
  process.send({ type: 'done' });
};

if (process.argv[2] === '--worker') {
  try { await worker(); process.exit(0); } catch (error) { console.error(error.stack); process.exit(1); }
} else {
  assert(fs.existsSync(path.join(root, 'dist/core/instance/instance-supervisor.js')), 'Build server first');
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  const work = fs.mkdtempSync(path.join(root, '.cache/pty-lifecycle-'));
  const config = path.join(root, 'config/instances.json');
  const fingerprint = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent';
  const targets = [config, ...['src/core/pty/pty-process-adapter.ts', 'src/core/instance/instance-supervisor.ts'].map(file => path.join(root, file))];
  const before = targets.map(fingerprint);
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const inventory = () => {
    const needle = work.replaceAll("'", "''");
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `$taskProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.CommandLine.Contains('child.cjs') }); ConvertTo-Json -InputObject @($taskProcesses | ForEach-Object { [int]$_.ProcessId }) -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); return JSON.parse(run.stdout.trim());
  };
  const groups = [];
  let failed = false, cleanupError;
  try {
    for (const group of ['control', 'pressure']) {
      const child = spawn(process.execPath, ['--expose-gc', '--unhandled-rejections=strict', fileURLToPath(import.meta.url), '--worker', path.join(work, group), group], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const record = { group, workerPid: child.pid, snapshots: [], stdout: '', stderr: '' };
      groups.push(record);
      child.stdout.on('data', chunk => { record.stdout += chunk; }); child.stderr.on('data', chunk => { record.stderr += chunk; });
      let messageError;
      child.on('message', message => {
        if (message.type !== 'snapshot') return;
        try {
          assert.equal(message.value.workerPid, child.pid);
          const count = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${child.pid} -ErrorAction Stop).HandleCount`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
          assert.equal(count.status, 0, count.stderr);
          const osHandleCount = Number(count.stdout.trim());
          assert(Number.isInteger(osHandleCount) && osHandleCount > 0);
          record.snapshots.push({ ...message.value, osHandleCount });
          console.log(`[pty-lifecycle] ${group}/${message.value.label}: active inputs=${message.value.activeInputSockets}, queued=${message.value.queuedBytes}, OS handles=${osHandleCount}`);
          child.send({ ack: message.value.label });
        } catch (error) { messageError = error; child.send({ ack: message.value.label }); }
      });
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }, 90000);
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
      Object.assign(record, exit);
      if (messageError) throw messageError;
      assert.equal(exit.code, 0, record.stderr);
      assert.equal(record.snapshots.length, 11, 'Baseline + 8 rounds + dispose + 5s snapshots required');
      assert(record.snapshots.slice(1, 9).every(item => item.previousChildGone), 'Every generation independently ended');
    }
    assert.equal(inventory().length, 0, 'No fixture children may remain');
  } catch (error) { failed = true; console.error(error.stack); }
  finally {
    try {
      for (const pid of inventory()) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      assert.equal(inventory().length, 0);
      assert.equal(path.dirname(path.resolve(work)), path.join(root, '.cache'));
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) { cleanupError = error.message; failed = true; }
    const unchanged = JSON.stringify(targets.map(fingerprint)) === JSON.stringify(before);
    if (!unchanged) failed = true;
    const retained = groups.some(group => group.snapshots.at(-1)?.activeInputSockets > 0 || group.snapshots.at(-1)?.queuedBytes > 0);
    const nodePtyVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/node-pty/package.json'), 'utf8')).version;
    fs.writeFileSync(path.join(root, '.cache/pty-lifecycle-evidence.json'), JSON.stringify({ node: process.version, nodePtyVersion, platform: process.platform, osRelease: os.release(), groups, failed, cleanupError, unchanged, retained, fixtureCleaned: !fs.existsSync(work) }, null, 2));
    console.log(`[pty-lifecycle] failed=${failed}, retained=${retained}`);
    process.exitCode = failed ? 1 : retained ? 2 : 0;
  }
}
