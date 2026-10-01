// Production UI regression in an isolated headless Chromium profile. No game
// process or user config is used. Fixture API validates with the compiled schema.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node >=24');
const { CreateInstanceSchema } = await import('../dist/api/http/schemas/instance-schemas.js');
const webRoot = path.resolve(process.env.SQUASH_FORM_WEB_ROOT ?? path.join(root, 'frontend/dist'));
assert(fs.existsSync(path.join(webRoot, 'index.html')), 'Build frontend first');
const candidates = process.platform === 'win32'
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const browserPath = process.env.SQUASH_BROWSER_PATH ?? candidates.find(candidate => fs.existsSync(candidate));
assert(browserPath && fs.existsSync(browserPath), 'Install Chromium or set SQUASH_BROWSER_PATH');
fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, '.cache/instance-form-'));
const userConfig = path.join(root, 'config/instances.json');
const fingerprint = () => fs.existsSync(userConfig) ? crypto.createHash('sha256').update(fs.readFileSync(userConfig)).digest('hex') : 'absent';
const originalFingerprint = fingerprint();
const configFile = path.join(work, 'instances.json');
const initial = id => CreateInstanceSchema.parse({ id, name: id, cwd: '.', executable: 'unused', args: [id], env: { FIXTURE: id }, logDir: `logs-${id}`, restartPolicy: 'always', stopCommand: 'quit\n' });
const configs = new Map(['alpha', 'beta'].map(id => [id, initial(id)]));
const persist = () => fs.writeFileSync(configFile, JSON.stringify([...configs.values()]));
persist();
const requests = [];
const pending = [];
const checks = [];
let browser;
let socket;
let failed = false;
let browserOutput = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, ms = 15000) => {
  const end = Date.now() + ms;
  do { const value = await predicate(); if (value) return value; await sleep(50); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
};
const check = (label, condition) => {
  checks.push({ label, passed: Boolean(condition) });
  console.log(`[form] ${condition ? 'PASS' : 'FAIL'} ${label}`);
  assert(condition, label);
};
const send = (res, data, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status === 200 ? { success: true, data } : { success: false, error: { message: data } }));
};
const server = http.createServer(async (req, res) => {
  try {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/api/auth/status') return send(res, { loginEnabled: false });
    if (route === '/api/instances' && req.method === 'GET') return send(res, [...configs.values()].map(config => ({ config, runtime: { id: config.id, status: 'stopped', viewers: 0 } })));
    if (route.startsWith('/api/instances/') && req.method === 'GET') return send(res, { config: configs.get(route.split('/').at(-1)) });
    if (route === '/api/instances' && req.method === 'POST' || route.startsWith('/api/instances/') && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      requests.push({ method: req.method, route, payload });
      const parsed = CreateInstanceSchema.parse(payload);
      pending.push({ res, parsed });
      return;
    }
    if (route.startsWith('/api/')) return send(res, 'Unknown fixture endpoint', 404);
    const file = path.resolve(webRoot, `.${route === '/' ? '/index.html' : route}`);
    if (!file.startsWith(webRoot + path.sep)) return send(res, 'Invalid fixture path', 400);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    // Enforce isolation even when the supplied build bakes in a different API
    // or WebSocket origin. Build instructions alone cannot prevent real writes.
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': "connect-src 'self'" });
    res.end(fs.readFileSync(file));
  } catch (error) { send(res, error.message, 400); }
});
const finish = (ok = true) => {
  assert.equal(pending.length, 1, 'Exactly one mutation must be pending');
  const { res, parsed } = pending.shift();
  if (ok) { configs.set(parsed.id, parsed); persist(); send(res, parsed); }
  else send(res, 'Fixture save rejected', 400);
};
const calls = new Map();
let sequence = 0;
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { calls.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  calls.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const modal = `document.querySelector('.ant-modal:not([style*="display: none"])')`;
const modalVisible = () => evaluate(`!!(${modal}) && ${modal}.getBoundingClientRect().height > 0`);
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const clickSave = () => evaluate(`${modal}.querySelector('.ant-modal-footer .ant-btn-primary').click()`);
const input = (id, value) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles: true})); })()`);
const edit = async id => {
  await evaluate(`Array.from(document.querySelectorAll('tr')).find(row => row.innerText.includes(${JSON.stringify(id)})).querySelector('button[title="Edit"]').click()`);
  await waitFor(modalVisible, `open ${id}`);
  await waitFor(() => evaluate(`document.getElementById('id')?.value === ${JSON.stringify(id)}`), `${id} fields`);
};
const saved = async () => { finish(); await waitFor(async () => !await modalVisible(), 'save closes dialog'); };
const readBack = async (base, id) => (await (await fetch(`${base}/api/instances/${id}`)).json()).data.config;

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  check('fixture restricts browser API connections to same origin', (await fetch(base)).headers.get('content-security-policy') === "connect-src 'self'");
  browser = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(work, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--window-size=1280,900', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  browser.once('error', error => { browserOutput += error.message; });
  browser.stderr.on('data', chunk => { browserOutput += chunk; });
  browser.stdout.on('data', chunk => { browserOutput += chunk; });
  const endpoint = await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(browserOutput)?.[1], 'browser debugging endpoint');
  const debuggerOrigin = new URL(endpoint).origin.replace('ws:', 'http:');
  const pages = await (await fetch(`${debuggerOrigin}/json/list`)).json();
  const page = pages.find(item => item.type === 'page');
  assert(page, 'Browser page exists');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const call = calls.get(message.id);
    if (!call) return;
    clearTimeout(call.timer); calls.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
  };
  await command('Page.enable');
  await command('Page.navigate', { url: base });
  await waitFor(() => evaluate(`document.querySelectorAll('button[title="Edit"]').length === 2`), 'instances loaded');

  // Baseline reproduction intentionally fails here if hidden values are lost.
  await edit('alpha');
  await input('name', 'alpha edited');
  await input('restartDelayMs', '');
  await clickSave();
  await waitFor(() => pending.length, 'alpha request');
  check('edit payload retains alpha env/logDir', requests.at(-1).payload.env?.FIXTURE === 'alpha' && requests.at(-1).payload.logDir === 'logs-alpha');
  check('cleared restart delay is omitted', !Object.hasOwn(requests.at(-1).payload, 'restartDelayMs'));
  check('stop command trailing Enter preserved', requests.at(-1).payload.stopCommand === 'quit\n');
  const count = requests.length;
  await evaluate(`${modal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); ${modal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));`);
  await clickSave();
  await sleep(250);
  check('repeated submit while pending makes one request', requests.length === count && pending.length === 1);
  check('pending save shows loading and disables fields/cancel/create/edit', await evaluate(`${modal}.querySelector('.ant-btn-loading') !== null && document.getElementById('name').disabled && ${modal}.querySelector('.ant-modal-footer .ant-btn-default').disabled && Array.from(document.querySelectorAll('button[title="Edit"]')).every(el=>el.disabled) && Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='Create Instance').disabled`));
  await evaluate(`${modal}.querySelector('.ant-modal-footer .ant-btn-default').click(); document.querySelector('.ant-modal-wrap').click(); Array.from(document.querySelectorAll('button[title="Edit"]')).at(-1).click();`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  check('pending dialog cannot close or switch via cancel/mask/Escape/edit', await modalVisible() && await evaluate(`document.getElementById('id').value === 'alpha' && !${modal}.querySelector('.ant-modal-close')`));
  await saved();
  const alpha = await readBack(base, 'alpha');
  check('successful edit readback preserves hidden fields and defaults', alpha.env.FIXTURE === 'alpha' && alpha.logDir === 'logs-alpha' && alpha.name === 'alpha edited' && alpha.restartDelayMs === 3000);

  await edit('beta');
  await input('name', 'beta edited');
  await clickSave(); await waitFor(() => pending.length, 'beta request');
  check('editing beta uses its own hidden fields', requests.at(-1).payload.env?.FIXTURE === 'beta' && requests.at(-1).payload.logDir === 'logs-beta');
  finish(false);
  await waitFor(() => evaluate(`document.body.innerText.includes('Fixture save rejected')`), 'failure message');
  await waitFor(() => evaluate(`!document.getElementById('name').disabled`), 'failure unlock');
  check('failed save retains editable dialog and values', await modalVisible() && await evaluate(`document.getElementById('name').value === 'beta edited'`));
  check('failed save does not persist', (await readBack(base, 'beta')).name === 'beta');
  await input('name', 'beta retry'); await clickSave(); await waitFor(() => pending.length, 'retry request'); await saved();
  check('retry succeeds and updates list', (await readBack(base, 'beta')).name === 'beta retry' && await evaluate(`document.body.innerText.includes('beta retry')`));

  await evaluate(`Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='Create Instance').click()`);
  await waitFor(modalVisible, 'create dialog');
  const beforeInvalid = requests.length;
  await clickSave();
  await waitFor(() => evaluate(`document.querySelector('.ant-form-item-explain-error') !== null`), 'invalid form error');
  check('invalid form sends nothing and remains editable', requests.length === beforeInvalid && await evaluate(`!document.getElementById('id').disabled && !${modal}.querySelector('.ant-btn-loading')`));
  await input('id', 'created');
  await evaluate(`${modal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); ${modal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));`);
  await waitFor(() => pending.length, 'create request'); await sleep(250);
  check('same-turn double create produces one POST', requests.length === beforeInvalid + 1 && pending.length === 1 && requests.at(-1).method === 'POST');
  check('all create inputs including ID are disabled while pending', await evaluate(`Array.from(${modal}.querySelectorAll('input, textarea, button[role="switch"]')).every(el => el.disabled) && document.getElementById('id').disabled`));
  check('create payload inherits no hidden edit values', !Object.hasOwn(requests.at(-1).payload, 'env') && !Object.hasOwn(requests.at(-1).payload, 'logDir'));
  await saved();
  const created = await readBack(base, 'created');
  check('create readback has independent defaults', Object.keys(created.env).length === 0 && created.logDir === 'logs' && created.name === 'created');
  const disk = JSON.parse(fs.readFileSync(configFile));
  check('isolated persisted configs retain both original hidden values', disk.find(item => item.id === 'alpha').env.FIXTURE === 'alpha' && disk.find(item => item.id === 'beta').logDir === 'logs-beta');
} catch (error) {
  failed = true; console.error(error.stack ?? error);
  if (socket?.readyState === WebSocket.OPEN) {
    try { console.error('Page state:', await evaluate(`JSON.stringify({text:document.body.innerText,resources:performance.getEntriesByType('resource').map(item=>item.name)})`)); } catch { /* preserve original failure */ }
  }
}
finally {
  try {
    for (const item of pending.splice(0)) send(item.res, 'Fixture shutdown', 503);
    if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch { /* browser closes transport */ } }
    socket?.close();
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error('Fixture cleanup')); }
    calls.clear();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      try { await waitFor(() => browser.exitCode !== null || browser.signalCode !== null, 'browser exits', 5000); }
      catch {
        if (process.platform === 'win32') spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true });
        else browser.kill('SIGKILL');
        await waitFor(() => browser.exitCode !== null || browser.signalCode !== null, 'browser killed', 5000);
      }
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert(work.startsWith(path.join(root, '.cache') + path.sep));
    fs.rmSync(work, { recursive: true, force: true });
    assert.equal(fingerprint(), originalFingerprint, 'User config must not change');
  } catch (error) { failed = true; console.error(`Cleanup failed: ${error.stack}`); }
  fs.writeFileSync(path.join(root, '.cache/instance-form-evidence.json'), JSON.stringify({ node: process.version, browserPath, failed, checks, requests, fixtureCleaned: !fs.existsSync(work), userConfigUnchanged: fingerprint() === originalFingerprint }, null, 2));
  console.log(`[form] ${checks.filter(item => item.passed).length}/${checks.length} passed; failed=${failed}`);
}
process.exitCode = failed ? 1 : 0;
