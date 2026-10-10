// Windows adapter contract checks with real ConPTY and isolated child workers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.platform, 'win32');
assert(Number(process.versions.node.split('.')[0]) >= 24);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const until = async test => { const end = Date.now() + 15000; while (!test()) { assert(Date.now() < end, 'Timed out'); await sleep(10); } };

if (process.argv[2] === '--worker') {
  const [, , , work, mode] = process.argv;
  assert(path.resolve(work).startsWith(path.join(root, '.cache/pty-cleanup-')));
  const require = createRequire(import.meta.url);
  const nodePty = require('node-pty');
  const originalSpawn = nodePty.spawn;
  let nativeTerm, spawns = 0, taskkills = 0;
  nodePty.spawn = (...args) => {
    spawns++;
    nativeTerm = originalSpawn(...args); return nativeTerm;
  };
  if (mode === 'version') require('node-pty/package.json').version = 'unsupported';
  if (mode === 'shape') {
    const originalRead = fs.readFileSync;
    const artifact = require.resolve('node-pty/lib/windowsPtyAgent.js');
    fs.readFileSync = function (file, ...args) { return file === artifact ? Buffer.from('incompatible private layout') : Reflect.apply(originalRead, this, [file, ...args]); };
  }
  const childProcess = require('node:child_process');
  const originalExec = childProcess.execFile;
  childProcess.execFile = function (file, ...args) { if (file === 'taskkill') taskkills++; return Reflect.apply(originalExec, this, [file, ...args]); };
  syncBuiltinESMExports();
  const { createPtyProcess } = await import('../../dist/core/pty/pty-process-adapter.js');
  const options = { command: process.execPath, args: [path.join(work, 'child.cjs')], cwd: work, env: process.env, cols: 120, rows: 40, name: 'cleanup' };
  if (mode === 'version' || mode === 'shape') {
    assert.throws(() => createPtyProcess(options), mode === 'version' ? /requires node-pty/ : /compatibility artifact/);
    assert.equal(spawns, 0, 'Compatibility rejection must happen before allocating any PTY');
    console.log('PASS'); process.exit(0);
  }
  const adapter = createPtyProcess(options);
  let output = '', exits = [];
  adapter.onData(chunk => { output += chunk; });
  adapter.onExit(event => { exits.push(event); });
  await until(() => /READY:(\d+)[\r\n]/.test(output));
  const pid = Number(/READY:(\d+)[\r\n]/.exec(output)[1]);
  assert.equal(adapter.pid, pid); assert(alive(pid));
  process.send({ pid });
  const socket = nativeTerm._agent.inSocket;
  assert(!socket.destroyed);
  if (mode === 'active-error') {
    socket.emit('error', Object.assign(new Error('INJECTED_ACTIVE_EPIPE'), { code: 'EPIPE' }));
    console.log('INCORRECTLY_SWALLOWED'); process.exit(0);
  }
  adapter.write('ping\r'); await until(() => output.includes('PONG'));
  if (mode === 'force') { adapter.kill('force'); adapter.kill('force'); }
  else adapter.write(mode === 'failure' ? 'exit1\r' : 'exit0\r');
  await until(() => exits.length > 0);
  assert(!alive(pid));
  if (mode !== 'force') {
    assert.equal(exits[0].exitCode, mode === 'failure' ? 1 : 0);
    assert(output.includes('FINAL_OUTPUT'), 'Final output must flush before exit');
  }
  await until(() => socket.destroyed && !process._getActiveHandles().includes(socket));
  assert.equal(socket.writableLength, 0);
  let writes = 0;
  let resizes = 0, nativeKills = 0;
  nativeTerm.resize = () => { resizes++; throw new Error('Post-exit resize touched'); };
  nativeTerm.kill = () => { nativeKills++; throw new Error('Post-exit kill touched'); };
  const taskkillsBefore = taskkills;
  socket.write = () => { writes++; throw new Error('Post-exit input touched'); };
  adapter.write('late'); adapter.resize(80, 24); adapter.kill('force'); adapter.kill('graceful');
  assert.equal(writes, 0);
  assert.equal(resizes, 0); assert.equal(nativeKills, 0); assert.equal(taskkills, taskkillsBefore);
  nativeTerm._onExit.fire({ exitCode: 99 });
  assert.equal(exits.length, 1, 'Duplicate native exit must not notify twice');
  if (mode === 'late-error') {
    socket.emit('error', Object.assign(new Error('INJECTED_LATE_EINVAL'), { code: 'EINVAL' }));
    console.log('INCORRECTLY_SWALLOWED'); process.exit(0);
  }
  for (const code of ['EPIPE', 'EBADF', 'ERR_STREAM_DESTROYED', 'ERR_SOCKET_CLOSED']) socket.emit('error', Object.assign(new Error(code), { code }));
  await sleep(100);
  console.log('PASS'); process.exit(0);
} else {
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  const work = fs.mkdtempSync(path.join(root, '.cache/pty-cleanup-'));
  fs.writeFileSync(path.join(work, 'child.cjs'), "process.stdout.write('READY:'+process.pid+'\\n');process.stdin.on('data',c=>{const s=c.toString();if(s.includes('ping'))process.stdout.write('PONG\\n');if(s.includes('exit')){process.stdout.write('FINAL_OUTPUT\\n',()=>process.exit(s.includes('exit1')?1:0));}});");
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const inventory = () => {
    const needle = work.replaceAll("'", "''");
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `$taskPids = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.CommandLine.Contains('child.cjs') } | ForEach-Object { [int]$_.ProcessId }); ConvertTo-Json -InputObject $taskPids -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim());
  };
  const records = [];
  try {
    for (const mode of ['normal', 'failure', 'force', 'active-error', 'late-error', 'version', 'shape']) {
      const child = spawn(process.execPath, ['--unhandled-rejections=strict', fileURLToPath(import.meta.url), '--worker', work, mode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const record = { mode, stdout: '', stderr: '' }; records.push(record);
      child.stdout.on('data', c => { record.stdout += c; }); child.stderr.on('data', c => { record.stderr += c; });
      child.on('message', message => { record.pid = message.pid; });
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }, 30000);
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
      Object.assign(record, exit);
      const injection = mode === 'active-error' ? 'INJECTED_ACTIVE_EPIPE' : mode === 'late-error' ? 'INJECTED_LATE_EINVAL' : undefined;
      if (injection) { assert.equal(exit.code, 1, record.stderr); assert(record.stderr.includes(injection)); assert(!record.stdout.includes('INCORRECTLY_SWALLOWED')); }
      else { assert.equal(exit.code, 0, record.stderr); assert(record.stdout.includes('PASS')); }
      // An intentional active-session fatal error can orphan its fixture. End
      // only this task's independently enumerated fixture before the next case.
      for (const pid of inventory()) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      assert.equal(inventory().length, 0);
      console.log(`[pty-cleanup] PASS ${mode}`);
    }
  } finally {
    for (const pid of inventory()) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    assert.equal(inventory().length, 0);
    assert.equal(path.dirname(path.resolve(work)), path.join(root, '.cache'));
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.writeFileSync(path.join(root, '.cache/pty-cleanup-contract-evidence.json'), JSON.stringify({ node: process.version, records, fixtureCleaned: !fs.existsSync(work) }, null, 2));
  }
}
