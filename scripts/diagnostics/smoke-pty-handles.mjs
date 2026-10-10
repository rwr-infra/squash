#!/usr/bin/env node
/**
 * Windows PTY handle attribution probe (investigation only, no production use).
 *
 * Runs rounds of real ConPTY children in an isolated worker process and takes a
 * per-round census of the worker's OS handles BY OBJECT TYPE (via a PowerShell
 * NtQuerySystemInformation(SystemExtendedHandleInformation) helper), plus the
 * worker's own libuv active-handle census and WeakRef+GC survival of the
 * node-pty terminal objects.
 *
 * Modes:
 *   dependency     - node-pty exactly as shipped: nothing is torn down beyond
 *                    node-pty's own natural-exit path.
 *   conin-destroy  - additionally destroys agent._agent.inSocket after the real
 *                    PTY exit, i.e. the squash adapter's guarantee (microsoft/
 *                    node-pty#947 workaround). Private access stays in this
 *                    test, never in production code.
 *   supervisor     - rounds driven by the compiled production supervisor
 *                    (run `npm run build:server` first): real adapter, parser,
 *                    log writer and state machine.
 *
 * Exit codes: 0 = no handle growth across rounds; 2 = retained resources
 * observed (diagnostic, not a safe pass; current node-pty leaks per round);
 * 1 = harness/child/census failure, or (conin-destroy/supervisor modes) the
 * input-socket release guarantee regressed (active sockets accumulate).
 *
 * Requires Windows, Node >=24. Uses only isolated fixtures under .cache/.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const isWindows = process.platform === 'win32';
const ROOT = path.resolve(import.meta.dirname, '../..');
const CACHE_DIR = path.join(ROOT, '.cache', 'pty-handles');
const CWD_DIR = path.join(CACHE_DIR, 'cwd');
const CENSUS_PS1 = path.join(CACHE_DIR, 'census.ps1');

function parseArgs(argv) {
  const args = { mode: 'dependency', rounds: 8, settleMs: 1000, out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--rounds') args.rounds = Number(argv[++i]);
    else if (argv[i] === '--settleMs') args.settleMs = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--worker') args.worker = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!['dependency', 'conin-destroy', 'supervisor'].includes(args.mode)) throw new Error(`Unknown mode: ${args.mode}`);
  if (!Number.isInteger(args.rounds) || args.rounds < 1) throw new Error('--rounds must be a positive integer');
  return args;
}

// ---------------------------------------------------------------------------
// PowerShell census helper source. Written once to .cache/pty-handles/census.ps1
// and invoked per census round. Buckets the target process's handles by object
// type index; labels each distinct index with one duplicated handle +
// NtQueryObject(ObjectTypeInformation). Type-only queries do not touch the
// object and are safe on live pipe handles.
// ---------------------------------------------------------------------------
const CENSUS_PS1_SOURCE = `param([int]$TargetPid)
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public class NH {
  [DllImport("ntdll.dll")]
  public static extern int NtQuerySystemInformation(int infoClass, IntPtr info, int length, out int returnLength);
  [DllImport("ntdll.dll")]
  public static extern int NtQueryObject(IntPtr handle, int infoClass, IntPtr info, int length, out int returnLength);
  [DllImport("kernel32.dll")]
  public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  public static extern bool DuplicateHandle(IntPtr hSrcProcess, IntPtr hSource, IntPtr hTargetProcess, out IntPtr lpTargetHandle, int desiredAccess, bool bInheritHandle, int dwOptions);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr hObject);
}
'@
Add-Type -TypeDefinition $src

$STATUS_INFO_LENGTH_MISMATCH = -1073741820
$size = 1048576
$info = [IntPtr]::Zero
while ($true) {
  $info = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  $retLen = 0
  $status = [NH]::NtQuerySystemInformation(64, $info, $size, [ref]$retLen)
  if ($status -eq 0) { break }
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($info)
  $info = [IntPtr]::Zero
  if ($status -ne $STATUS_INFO_LENGTH_MISMATCH) { throw "NtQuerySystemInformation failed: $status" }
  $size = [Math]::Max($retLen + 65536, $size * 2)
}

try {
  $count = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($info).ToInt64()
  # Empirically verified layout on Win10 19045 x64 (SystemExtendedHandleInformation):
  # ULONG_PTR count at +0, 8 bytes of padding, then 40-byte entries:
  # Object(+0) UniqueProcessId(+8) HandleValue(+16) GrantedAccess(+24)
  # CreatorBackTraceIndex(+28,USHORT) ObjectTypeIndex(+30,USHORT) attrs/reserved(+32).
  $entrySize = 40
  $base = $info.ToInt64() + 16
  $counts = @{}
  $samples = @{}
  for ($i = 0L; $i -lt $count; $i++) {
    $p = $base + ($i * $entrySize)
    $ownerPid = [System.Runtime.InteropServices.Marshal]::ReadIntPtr([IntPtr]::new([Int64]($p + 8))).ToInt64()
    if ($ownerPid -ne $TargetPid) { continue }
    $typeIdx = [System.Runtime.InteropServices.Marshal]::ReadInt16([IntPtr]::new([Int64]($p + 30))) -band 0xFFFF
    $key = [string]$typeIdx
    if (-not $counts.ContainsKey($key)) {
      $counts[$key] = 0
      $samples[$key] = [System.Runtime.InteropServices.Marshal]::ReadIntPtr([IntPtr]::new([Int64]($p + 16))).ToInt64()
    }
    $counts[$key] = $counts[$key] + 1
  }

  $names = @{}
  $hProc = [NH]::OpenProcess(0x40, $false, $TargetPid)
  if ($hProc -eq [IntPtr]::Zero) { throw "OpenProcess($TargetPid) failed" }
  try {
    foreach ($key in $samples.Keys) {
      $dup = [IntPtr]::Zero
      if (-not [NH]::DuplicateHandle($hProc, [IntPtr]::new([Int64]$samples[$key]), [NH]::GetCurrentProcess(), [ref]$dup, 0, $false, 2)) { continue }
      try {
        $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(1024)
        try {
          $rl = 0
          if ([NH]::NtQueryObject($dup, 2, $buf, 1024, [ref]$rl) -eq 0) {
            $len = [System.Runtime.InteropServices.Marshal]::ReadInt16($buf) -band 0xFFFF
            $ptr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr([IntPtr]::new([Int64]($buf.ToInt64() + 8)))
            if ($len -gt 0 -and $ptr -ne [IntPtr]::Zero) {
              $names[$key] = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr, $len / 2)
            }
          }
        } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
      } finally { [NH]::CloseHandle($dup) | Out-Null }
    }
  } finally { [NH]::CloseHandle($hProc) | Out-Null }

  $gp = Get-Process -Id $TargetPid
  $typeCounts = [ordered]@{}
  foreach ($key in ($counts.Keys | Sort-Object {[int]$_})) {
    $label = if ($names.ContainsKey($key)) { $names[$key] } else { "type-$key" }
    $typeCounts[$label] = $counts[$key]
  }
  [pscustomobject]@{
    status = 'ok'
    handleCount = $gp.HandleCount
    threads = $gp.Threads.Count
    types = $typeCounts
  } | ConvertTo-Json -Compress -Depth 4
} finally {
  if ($info -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($info) }
}
`;

async function runCensus(targetPid, timeoutMs = 45000) {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CENSUS_PS1, '-TargetPid', String(targetPid)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, timeoutMs);
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`census powershell exited ${code}: ${err.trim().slice(0, 500)}`);
  const line = out.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`census produced no JSON: ${out.trim().slice(0, 500)}`);
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// Worker: performs the rounds. Private node-pty access (agent._agent.inSocket)
// exists ONLY here, in the test, mirroring what the production adapter does.
// ---------------------------------------------------------------------------
async function workerMain(args) {
  const readline = createInterface({ input: process.stdin });
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const waitGo = () => new Promise((resolve) => {
    const onLine = (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.cmd === 'go') { readline.removeListener('line', onLine); resolve(); }
    };
    readline.on('line', onLine);
  });
  const baseline = activeHandleCensus();
  send({ type: 'ready', baseline });
  // Wait for the parent's baseline census before any round spawns: with
  // --rounds 1 a late baseline would already contain round 1's retained
  // handles and report a false "no growth".
  await waitGo();

  // supervisorRounds/nodePtyRounds perform the rounds; nodePtyRounds returns
  // how many terminal objects survived GC, supervisor tracks none (one
  // supervisor is reused across rounds).
  let weakRefsAlive = null;
  if (args.mode === 'supervisor') {
    await supervisorRounds(args, send, waitGo);
  } else {
    weakRefsAlive = await nodePtyRounds(args, send, waitGo);
  }
  await sleep(5000);
  gc();
  await sleep(100);
  gc();
  send({ type: 'done', weakRefsAlive, activeHandles: activeHandleCensus() });
  process.exit(0);
}

// Rounds driven by the compiled production supervisor (dist build required):
// exercises the real adapter, parser, log writer and state machine. The
// production adapter destroys conin itself on the real PTY exit.
async function supervisorRounds(args, send, waitGo) {
  const { createInstanceSupervisor } = await import('../../dist/core/instance/instance-supervisor.js');
  const fixtureDir = path.join(CACHE_DIR, 'supervisor-fixture');
  mkdirSync(fixtureDir, { recursive: true });
  let supervisor = null;
  let output = '';
  for (let round = 1; round <= args.rounds; round++) {
    if (!supervisor) {
      supervisor = await createInstanceSupervisor({
        id: 'handles',
        name: 'handles',
        cwd: fixtureDir,
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("RDY\\n")'],
        env: {},
        logDir: fixtureDir,
        restartPolicy: 'never',
        stopTimeoutMs: 3000
      });
      supervisor.onData((chunk) => { output += chunk; });
      await supervisor.start();
    } else {
      output = '';
      await supervisor.restart();
    }
    await until(() => output.includes('RDY'), 30000, `round ${round}: no output marker`);
    await until(() => supervisor.getRuntime().status === 'stopped', 30000, `round ${round}: did not reach stopped`);
    if (supervisor.getRuntime().exitCode !== 0) throw new Error(`round ${round}: exitCode ${supervisor.getRuntime().exitCode}`);
    await sleep(args.settleMs);
    gc();
    await sleep(100);
    gc();
    send({ type: 'round', round, exitCode: 0, markerSeen: true, pidAtExit: undefined, weakRefsTotal: null, weakRefsAlive: null, activeHandles: activeHandleCensus() });
    await waitGo();
  }
  await supervisor.dispose();
}

// Direct node-pty rounds. Private node-pty access (agent._agent.inSocket)
// exists ONLY in this test, mirroring what the production adapter does.
async function nodePtyRounds(args, send, waitGo) {
  const pty = (await import('node-pty')).default;
  const weakRefs = [];
  for (let round = 1; round <= args.rounds; round++) {
    const term = pty.spawn(process.execPath, ['-e', 'process.stdout.write("RDY")'], {
      name: 'pty-handles-probe',
      cols: 80,
      rows: 24,
      cwd: CWD_DIR,
      env: process.env
    });
    let sawMarker = false;
    term.onData((chunk) => { if (chunk.includes('RDY')) sawMarker = true; });
    const exitInfo = await new Promise((resolve, reject) => {
      term.onExit(resolve);
      setTimeout(() => reject(new Error(`round ${round}: PTY did not exit within 30s (marker seen: ${sawMarker})`)), 30000);
    });
    if (args.mode === 'conin-destroy') {
      // Same rule as the production adapter: destroy conin at the real exit.
      // Tolerated post-exit pipe errors only; anything else rethrows.
      const inSocket = term._agent.inSocket;
      inSocket.on('error', (error) => {
        if (['ERR_STREAM_DESTROYED', 'ERR_SOCKET_CLOSED', 'EPIPE', 'EBADF'].includes(error.code ?? '')) return;
        throw error;
      });
      inSocket.destroy();
    }
    // node-pty's own cleanup (_cleanUpProcess -> outSocket.destroy) has already
    // run by the time onExit fires; settle for teardown of destroyed handles.
    await sleep(args.settleMs);
    weakRefs.push(new WeakRef(term));
    gc();
    await sleep(100);
    gc();
    const alive = weakRefs.filter((r) => r.deref() !== undefined).length;
    send({ type: 'round', round, exitCode: exitInfo.exitCode, markerSeen: sawMarker, pidAtExit: term.pid, weakRefsTotal: weakRefs.length, weakRefsAlive: alive, activeHandles: activeHandleCensus() });
    await waitGo();
  }
  return weakRefs.filter((r) => r.deref() !== undefined).length;
}

function until(condition, timeoutMs, what) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function activeHandleCensus() {
  const byCtor = {};
  let sockets = 0;
  let liveSockets = 0;
  for (const h of process._getActiveHandles()) {
    const name = h?.constructor?.name ?? typeof h;
    byCtor[name] = (byCtor[name] ?? 0) + 1;
    if (name === 'Socket') {
      sockets++;
      if (!h.destroyed) liveSockets++;
    }
  }
  return { total: Object.values(byCtor).reduce((a, b) => a + b, 0), sockets, liveSockets, byCtor };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Parent: drives the worker and takes the OS-level census between rounds.
// ---------------------------------------------------------------------------
async function parentMain(args) {
  if (!isWindows) throw new Error('This probe is Windows-only');
  mkdirSync(CWD_DIR, { recursive: true });
  writeFileSync(CENSUS_PS1, CENSUS_PS1_SOURCE.replace(/\n/g, '\r\n'), 'utf8');

  const nodePtyVersion = nodePtyVersionOf();
  const worker = spawn(process.execPath, ['--expose-gc', import.meta.filename, '--worker', '--mode', args.mode, '--rounds', String(args.rounds), '--settleMs', String(args.settleMs)], { stdio: ['pipe', 'pipe', 'pipe'] });
  worker.stderr.on('data', (c) => process.stderr.write(c));

  const readline = createInterface({ input: worker.stdout });
  const rows = [];
  let baseline = null;
  let done = null;
  let failure = null;

  const overall = setTimeout(() => { failure ??= new Error('overall watchdog (15 min) expired'); try { worker.kill(); } catch { /* already gone */ } }, 15 * 60 * 1000);

  await new Promise((resolve, reject) => {
    const onLine = async (line) => {
      let msg; try { msg = JSON.parse(line); } catch { process.stderr.write(`worker: ${line}\n`); return; }
      try {
        if (msg.type === 'ready') {
          baseline = { worker: msg.baseline, ps: await runCensus(worker.pid) };
          rows.push({ round: 0, ...baseline });
          worker.stdin.write('{"cmd":"go"}\n');
        } else if (msg.type === 'round') {
          const ps = await runCensus(worker.pid);
          rows.push({ round: msg.round, worker: msg.activeHandles, meta: { exitCode: msg.exitCode, markerSeen: msg.markerSeen, pidAtExit: msg.pidAtExit, weakRefsTotal: msg.weakRefsTotal, weakRefsAlive: msg.weakRefsAlive }, ps });
          worker.stdin.write('{"cmd":"go"}\n');
        } else if (msg.type === 'done') {
          done = { worker: msg.activeHandles, weakRefsAlive: msg.weakRefsAlive };
          resolve();
        } else if (msg.type === 'error') {
          reject(new Error(msg.message));
        }
      } catch (e) { reject(e); }
    };
    readline.on('line', onLine);
    worker.on('close', (code) => { if (!done && !failure) reject(new Error(`worker exited early with code ${code}`)); else resolve(); });
  }).catch((e) => { failure ??= e; });
  clearTimeout(overall);

  const evidence = {
    probe: 'pty-handles',
    mode: args.mode,
    rounds: args.rounds,
    settleMs: args.settleMs,
    node: process.version,
    nodePtyVersion,
    platform: process.platform,
    osRelease: os.release(),
    startedAt: new Date().toISOString(),
    rows,
    final: done,
    summary: summarize(rows)
  };
  const outPath = args.out || path.join(CACHE_DIR, `pty-handles-evidence-${args.mode}.json`);
  writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');

  printReport(evidence);

  if (failure) { console.error(`FAIL: ${failure.message}`); process.exit(1); }
  // The squash adapter guarantee: with conin destroyed, no active sockets may
  // accumulate across rounds. Compare from round 1 on: the pre-round baseline
  // misses lazily-activated stdio sockets of the harness itself.
  if (args.mode === 'conin-destroy' || args.mode === 'supervisor') {
    const firstStable = rows[1]?.worker?.liveSockets ?? 0;
    const last = rows.at(-1)?.worker?.liveSockets ?? 0;
    if (last > firstStable) { console.error(`FAIL: live sockets grew ${firstStable} -> ${last} despite conin destroy`); process.exit(1); }
  }
  // Current node-pty retains per-round resources (see type deltas): keep the
 // diagnostic non-clean like smoke:pty-lifecycle, never counted as a safe pass.
  const growth = evidence.summary?.handleCount?.delta ?? 0;
  if (growth > 0) {
    console.log(`verdict: RETAINED resources (+${growth} handles) — diagnostic exit 2, not a safe pass`);
    process.exit(2);
  }
  process.exit(0);
}

function summarize(rows) {
  if (rows.length < 2) return null;
  const first = rows[0];
  const last = rows.at(-1);
  const typeDelta = {};
  for (const [type, n] of Object.entries(last.ps.types)) {
    const d = n - (first.ps.types[type] ?? 0);
    if (d !== 0) typeDelta[type] = d;
  }
  for (const [type, n] of Object.entries(first.ps.types)) {
    if (!(type in last.ps.types)) typeDelta[type] = -n;
  }
  return {
    handleCount: { first: first.ps.handleCount, last: last.ps.handleCount, delta: last.ps.handleCount - first.ps.handleCount, perRound: (last.ps.handleCount - first.ps.handleCount) / Math.max(1, last.round) },
    threads: { first: first.ps.threads, last: last.ps.threads, delta: last.ps.threads - first.ps.threads },
    liveSockets: { first: first.worker.liveSockets, last: last.worker.liveSockets },
    typeDelta
  };
}

function printReport(evidence) {
  const s = evidence.summary;
  console.log(`\n=== PTY handle attribution: mode=${evidence.mode} rounds=${evidence.rounds} nodePty=${evidence.nodePtyVersion} ===`);
  for (const row of evidence.rows) {
    console.log(`round ${String(row.round).padStart(2)}: OS handles=${row.ps.handleCount} threads=${row.ps.threads} liveSockets=${row.worker.liveSockets} weakRefsAlive=${row.meta?.weakRefsAlive ?? '-'}/${row.meta?.weakRefsTotal ?? '-'} types=${JSON.stringify(row.ps.types)}`);
  }
  if (s) {
    console.log(`\ndelta over ${evidence.rows.at(-1).round} rounds: handles ${s.handleCount.delta} (~${s.handleCount.perRound.toFixed(1)}/round), threads ${s.threads.delta}, liveSockets ${s.liveSockets.first}->${s.liveSockets.last}`);
    console.log(`type deltas: ${JSON.stringify(s.typeDelta)}`);
  }
}

function nodePtyVersionOf() {
  return JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'node-pty', 'package.json'), 'utf8')).version;
}

const args = parseArgs(process.argv.slice(2));
if (args.worker) {
  workerMain(args).catch((e) => { process.stdout.write(`${JSON.stringify({ type: 'error', message: e.message })}\n`); process.exit(1); });
} else {
  parentMain(args).catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1); });
}
