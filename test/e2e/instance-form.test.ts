// The instance form and the instance templates in a real browser: the
// production frontend (frontend/dist) against a fixture API that validates
// with the real schemas, driven through headless Chrome/Chromium over the
// DevTools protocol, in an isolated profile. No game process or user config
// is used. Checks:
//   - editing keeps the fields the form does not show (env, logDir), a
//     cleared number is omitted, the stop command's trailing Enter survives;
//     editing B after A shows and saves B's values
//   - while a save is pending: one request however often it is submitted,
//     fields and buttons disabled, the dialog cannot close or switch; a
//     failed save keeps the dialog and its values, a retry succeeds
//   - an invalid create sends nothing; a double create sends one POST; a
//     create inherits nothing from an earlier edit
//   - templates: picking fills the form (and switching resets what the new
//     one does not set), a malformed template fills only its well-typed
//     fields, "Save as template" from create and edit (never the ID, nor a
//     Name equal to it), Escape closes only the top dialog, a taken name is
//     reported on the field, the drawer lists, edits, deletes and creates
//     from templates, a save in flight makes one request
//
// Usage: VITE_API_URL= npm --prefix frontend run build && npm run smoke:instance-form
// (SQUASH_FORM_WEB_ROOT=<dir> tests another build; SQUASH_BROWSER_PATH=<path>
// picks the browser.)
//
// The flow is the former smoke's, run once (test/helpers/checks.ts): what it
// observes depends on timing. A failed check stops it, as it stopped the
// smoke.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CreateInstanceSchema } from '../../src/api/http/schemas/instance-schemas.js';
import { TemplateBodySchema } from '../../src/api/http/schemas/template-schemas.js';
import { findBrowser, startBrowser, type Browser } from '../helpers/cdp.js';
import { CheckFailed, recordedChecks } from '../helpers/checks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The flow's own limit: the smoke took about 15 s.
const FLOW_TIMEOUT_MS = 180_000;

const { check: record, run } = recordedChecks([
  'fixture restricts browser API connections to same origin',
  'edit payload retains alpha env/logDir',
  'cleared restart delay is omitted',
  'stop command trailing Enter preserved',
  'repeated submit while pending makes one request',
  'pending save shows loading and disables fields/cancel/create/edit',
  'pending dialog cannot close or switch via cancel/mask/Escape/edit',
  'successful edit readback preserves hidden fields and defaults',
  'editing beta uses its own hidden fields',
  'failed save retains editable dialog and values',
  'failed save does not persist',
  'retry succeeds and updates list',
  'invalid form sends nothing and remains editable',
  'same-turn double create produces one POST',
  'all create inputs including ID are disabled while pending',
  'create payload inherits no hidden edit values',
  'create readback has independent defaults',
  'isolated persisted configs retain both original hidden values',
  'picking a template fills its fields and keeps the typed ID',
  'switching template resets what the new one does not set to the defaults',
  'applying a template clears the errors of the fields it refilled',
  'create from a template sends one POST',
  'create from a template posts its values with the ID',
  'a malformed template fills only its well-typed fields',
  'save as template from the create dialog prefills its settings',
  'Escape closes only the template dialog',
  'a Name equal to the Instance ID is left out of the template',
  'template dialog opens above the instance dialog',
  'template dialog is prefilled from the instance form without its ID',
  'a template without a name is not sent',
  '(setup) the name field is scrolled out of view and unfocused',
  'a taken name is reported on the name field and the dialog stays open',
  'saved template holds the instance settings only',
  'the instance dialog stays open with its values after saving a template',
  'drawer lists every template',
  'a malformed template is summarized by its usable fields',
  'the drawer summary shows the Enter after quit',
  'editing shows only what the template sets',
  'editing a template sends PUT for it',
  'editing a template replaces it with the form values',
  'deleting a template sends DELETE',
  '"Create instance" opens the create dialog filled from that template',
  "switching away from the drawer's template drops its values too",
  'a plain Create starts from the defaults again',
  'a plain Create has no template picked',
  'a new template starts empty',
  'a template save in flight makes one request',
  'a template save in flight disables its fields and buttons',
  'an empty template posts no values (name trimmed)'
]);

// Request bodies and page values, as the frontend sends and shows them.
type Json = Record<string, any>;
type Pending = { readonly res: http.ServerResponse; readonly parsed: Json };

const webRoot = path.resolve(process.env.SQUASH_FORM_WEB_ROOT ?? path.join(root, 'frontend/dist'));
const userConfig = path.join(root, 'config/instances.json');
const fingerprint = () => fs.existsSync(userConfig) ? crypto.createHash('sha256').update(fs.readFileSync(userConfig)).digest('hex') : 'absent';
let originalFingerprint = '';
// Set up by the flow, not while tests are collected: a filter that skips the
// file runs no hook, and nothing made earlier would be cleaned up.
let work = '';
let configFile = '';
const initial = (id: string) => CreateInstanceSchema.parse({ id, name: id, cwd: '.', executable: 'unused', args: [id], env: { FIXTURE: id }, logDir: `logs-${id}`, restartPolicy: 'always', stopCommand: 'quit\n' }) as Json;
const configs = new Map<string, Json>(['alpha', 'beta'].map((id) => [id, initial(id)]));
const persist = () => fs.writeFileSync(configFile, JSON.stringify([...configs.values()]));
const castlingValues = { name: 'Castling server', cwd: '/srv/castling', executable: './rwr_server', args: ['--a', '--b'], autoStart: true, restartPolicy: 'on-failure', restartDelayMs: 5000, stopCommand: 'quit\n', stopTimeoutMs: 20000 };
const templates = new Map<string, Json>([
  ['t-castling', { id: 't-castling', name: 'Castling', values: castlingValues }],
  ['t-minimal', { id: 't-minimal', name: 'Minimal', values: { executable: './other' } }],
  // As if hand-edited: wrong types and foreign fields, which the UI must drop.
  ['t-broken', { id: 't-broken', name: 'Broken', values: { executable: './bad', args: '--a', stopCommand: ['quit', ''], id: 'evil', env: { A: '1' }, autoStart: 'yes', restartDelayMs: -1, stopTimeoutMs: 1.5, cwd: '' } }]
]);
const templateRequests: { readonly method: string; readonly route: string; readonly payload: Json | undefined }[] = [];
// While `hold` is set, template writes wait for release() (like `pending`
// for instances), so a test can look at the dialog mid-save.
const templateGate = { hold: false, held: [] as (() => void)[], release() { this.hold = false; for (const respond of this.held.splice(0)) respond(); } };
const requests: { readonly method: string; readonly route: string; readonly payload: Json }[] = [];
const pending: Pending[] = [];
let browser: Browser | undefined;
let server: http.Server | undefined;
// Set by cleanup: a flow that overran its time and goes on starts no
// browser, since nothing would close it.
let stopping = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async <T>(predicate: () => T | Promise<T>, label: string, ms = 15000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  do { const value = await predicate(); if (value) return value; await sleep(50); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
};
const check = (label: string, condition: unknown) => {
  console.log(`[form] ${condition ? 'PASS' : 'FAIL'} ${label}`);
  if (!record(label, Boolean(condition))) throw new CheckFailed(label);
};
// check() for a deep comparison; prints both sides when they differ.
const checkEqual = (label: string, actual: unknown, expected: unknown) => {
  const equal = isDeepStrictEqual(actual, expected);
  if (!equal) console.error(`[form] ${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  check(label, equal);
};
const send = (res: http.ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status === 200 ? { success: true, data } : { success: false, error: { message: data } }));
};
const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  try {
    const route = new URL(req.url!, 'http://localhost').pathname;
    if (route === '/api/auth/status') return send(res, { loginEnabled: false });
    if (route === '/api/instances' && req.method === 'GET') return send(res, [...configs.values()].map((config) => ({ config, runtime: { id: config.id, status: 'stopped', viewers: 0 } })));
    if (route.startsWith('/api/instances/') && req.method === 'GET') return send(res, { config: configs.get(route.split('/').at(-1)!) });
    // Templates answer at once (no pending gate); validated with the real
    // schema, names unique ignoring case like the real service.
    if (route === '/api/templates' && req.method === 'GET') return send(res, [...templates.values()]);
    if (route === '/api/templates' && req.method === 'POST' || route.startsWith('/api/templates/') && ['PUT', 'DELETE'].includes(req.method!)) {
      const id = route === '/api/templates' ? undefined : decodeURIComponent(route.split('/').at(-1)!);
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = body ? JSON.parse(body) as Json : undefined;
      templateRequests.push({ method: req.method!, route, payload });
      if (req.method === 'DELETE') return templates.delete(id!) ? send(res, { id, deleted: true }) : send(res, 'Template not found', 404);
      const parsed = TemplateBodySchema.parse(payload);
      const respond = () => {
        // Like the service: a name is checked only when it changes.
        const own = id === undefined ? undefined : templates.get(id);
        if (id !== undefined && !own) return send(res, 'Template not found', 404);
        const renamed = !own || own.name.toLowerCase() !== parsed.name.toLowerCase();
        if (renamed && [...templates.values()].some((template) => template.name.toLowerCase() === parsed.name.toLowerCase())) {
          res.writeHead(409, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: { code: 'TEMPLATE_NAME_TAKEN', message: `A template named "${parsed.name}" already exists` } }));
        }
        const template = { id: id ?? `t-new-${templateRequests.length}`, ...parsed };
        templates.set(template.id, template);
        return send(res, template);
      };
      if (templateGate.hold) return templateGate.held.push(respond);
      return respond();
    }
    if (route === '/api/instances' && req.method === 'POST' || route.startsWith('/api/instances/') && req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body) as Json;
      requests.push({ method: req.method!, route, payload });
      const parsed = CreateInstanceSchema.parse(payload) as Json;
      pending.push({ res, parsed });
      return;
    }
    if (route.startsWith('/api/')) return send(res, 'Unknown fixture endpoint', 404);
    const file = path.resolve(webRoot, `.${route === '/' ? '/index.html' : route}`);
    if (!file.startsWith(webRoot + path.sep)) return send(res, 'Invalid fixture path', 400);
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    // Enforce isolation even when the supplied build bakes in a different API
    // or WebSocket origin. Build instructions alone cannot prevent real writes.
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'content-security-policy': "connect-src 'self'" });
    res.end(fs.readFileSync(file));
  } catch (error) { send(res, (error as Error).message, 400); }
};
const finish = (ok = true) => {
  assert.equal(pending.length, 1, 'Exactly one mutation must be pending');
  const { res, parsed } = pending.shift()!;
  if (ok) { configs.set(parsed.id, parsed); persist(); send(res, parsed); }
  else send(res, 'Fixture save rejected', 400);
};

const flow = async () => {
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node >=24');
  assert(fs.existsSync(path.join(webRoot, 'index.html')), 'Build frontend first');
  const browserPath = findBrowser();
  assert(browserPath, 'Install Chromium or set SQUASH_BROWSER_PATH');
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  work = fs.mkdtempSync(path.join(root, '.cache/instance-form-'));
  originalFingerprint = fingerprint();
  configFile = path.join(work, 'instances.json');
  persist();
  server = http.createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  check('fixture restricts browser API connections to same origin', (await fetch(base)).headers.get('content-security-policy') === "connect-src 'self'");

  if (stopping) throw new Error('cleanup has begun: no browser');
  const { command, evaluate } = browser = startBrowser({ browserPath, profileDir: path.join(work, 'profile'), endpointTimeoutMs: 15000, commandTimeoutMs: 15000 });
  const modal = `document.querySelector('.ant-modal:not([style*="display: none"])')`;
  // Footer buttons by label: the instance modal's footer also holds "Save as template".
  const cancelButton = `Array.from(${modal}.querySelectorAll('.ant-modal-footer button')).find(el => el.innerText.trim() === 'Cancel')`;
  const modalVisible = () => evaluate(`!!(${modal}) && ${modal}.getBoundingClientRect().height > 0`);
  const clickSave = () => evaluate(`${modal}.querySelector('.ant-modal-footer .ant-btn-primary').click()`);
  const input = (id: string, value: string) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  const edit = async (id: string) => {
    await evaluate(`Array.from(document.querySelectorAll('tr')).find(row => row.innerText.includes(${JSON.stringify(id)})).querySelector('button[title="Edit"]').click()`);
    await waitFor(modalVisible, `open ${id}`);
    await waitFor(() => evaluate(`document.getElementById('id')?.value === ${JSON.stringify(id)}`), `${id} fields`);
  };
  const saved = async () => { finish(); await waitFor(async () => !await modalVisible(), 'save closes dialog'); };
  const readBack = async (base: string, id: string) => ((await (await fetch(`${base}/api/instances/${id}`)).json()) as Json).data.config as Json;

  await browser.connect();
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Page.navigate', { url: base });
  await waitFor(() => evaluate(`document.querySelectorAll('button[title="Edit"]').length === 2`), 'instances loaded');

  // Baseline reproduction intentionally fails here if hidden values are lost.
  await edit('alpha');
  await input('name', 'alpha edited');
  await input('restartDelayMs', '');
  await clickSave();
  await waitFor(() => pending.length, 'alpha request');
  check('edit payload retains alpha env/logDir', requests.at(-1)!.payload.env?.FIXTURE === 'alpha' && requests.at(-1)!.payload.logDir === 'logs-alpha');
  check('cleared restart delay is omitted', !Object.hasOwn(requests.at(-1)!.payload, 'restartDelayMs'));
  check('stop command trailing Enter preserved', requests.at(-1)!.payload.stopCommand === 'quit\n');
  const count = requests.length;
  await evaluate(`${modal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true})); ${modal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));`);
  await clickSave();
  await sleep(250);
  check('repeated submit while pending makes one request', requests.length === count && pending.length === 1);
  check('pending save shows loading and disables fields/cancel/create/edit', await evaluate(`${modal}.querySelector('.ant-btn-loading') !== null && document.getElementById('name').disabled && ${cancelButton}.disabled && Array.from(${modal}.querySelectorAll('.ant-modal-footer button')).find(el => el.innerText.includes('Save as template')).disabled && Array.from(document.querySelectorAll('button[title="Edit"]')).every(el=>el.disabled) && Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='Create Instance').disabled`));
  await evaluate(`${cancelButton}.click(); document.querySelector('.ant-modal-wrap').click(); Array.from(document.querySelectorAll('button[title="Edit"]')).at(-1).click();`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  check('pending dialog cannot close or switch via cancel/mask/Escape/edit', await modalVisible() && await evaluate(`document.getElementById('id').value === 'alpha' && !${modal}.querySelector('.ant-modal-close')`));
  await saved();
  const alpha = await readBack(base, 'alpha');
  check('successful edit readback preserves hidden fields and defaults', alpha.env.FIXTURE === 'alpha' && alpha.logDir === 'logs-alpha' && alpha.name === 'alpha edited' && alpha.restartDelayMs === 3000);

  await edit('beta');
  await input('name', 'beta edited');
  await clickSave(); await waitFor(() => pending.length, 'beta request');
  check('editing beta uses its own hidden fields', requests.at(-1)!.payload.env?.FIXTURE === 'beta' && requests.at(-1)!.payload.logDir === 'logs-beta');
  finish(false);
  await waitFor(() => evaluate(`document.body.innerText.includes('Fixture save rejected')`), 'failure message');
  await waitFor(() => evaluate(`!document.getElementById('name').disabled`), 'failure unlock');
  check('failed save retains editable dialog and values', await modalVisible() && await evaluate(`document.getElementById('name').value === 'beta edited'`));
  check('failed save does not persist', (await readBack(base, 'beta')).name === 'beta');
  await input('name', 'beta retry'); await clickSave(); await waitFor(() => pending.length, 'retry request'); await saved();
  // The list refetch can land after the dialog closes.
  const listed = await waitFor(() => evaluate(`document.body.innerText.includes('beta retry')`), 'list shows the retry').then(() => true, () => false);
  check('retry succeeds and updates list', (await readBack(base, 'beta')).name === 'beta retry' && listed);

  await evaluate(`Array.from(document.querySelectorAll('button')).find(el=>el.innerText==='Create Instance').click()`);
  await waitFor(modalVisible, 'create dialog');
  const beforeInvalid = requests.length;
  await clickSave();
  await waitFor(() => evaluate(`document.querySelector('.ant-form-item-explain-error') !== null`), 'invalid form error');
  check('invalid form sends nothing and remains editable', requests.length === beforeInvalid && await evaluate(`!document.getElementById('id').disabled && !${modal}.querySelector('.ant-btn-loading')`));
  await input('id', 'created');
  await evaluate(`${modal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})); ${modal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));`);
  await waitFor(() => pending.length, 'create request'); await sleep(250);
  check('same-turn double create produces one POST', requests.length === beforeInvalid + 1 && pending.length === 1 && requests.at(-1)!.method === 'POST');
  check('all create inputs including ID are disabled while pending', await evaluate(`Array.from(${modal}.querySelectorAll('input, textarea, button[role="switch"]')).every(el => el.disabled) && document.getElementById('id').disabled`));
  check('create payload inherits no hidden edit values', !Object.hasOwn(requests.at(-1)!.payload, 'env') && !Object.hasOwn(requests.at(-1)!.payload, 'logDir'));
  await saved();
  const created = await readBack(base, 'created');
  check('create readback has independent defaults', Object.keys(created.env).length === 0 && created.logDir === 'logs' && created.name === 'created');
  const disk = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Json[];
  check('isolated persisted configs retain both original hidden values', disk.find((item) => item.id === 'alpha')!.env.FIXTURE === 'alpha' && disk.find((item) => item.id === 'beta')!.logDir === 'logs-beta');

  // --- Templates --------------------------------------------------------------
  const visibleModals = `Array.from(document.querySelectorAll('.ant-modal')).filter(m => m.getBoundingClientRect().height > 0)`;
  const instanceModal = `${visibleModals}.find(m => /Instance/.test(m.querySelector('.ant-modal-title')?.innerText ?? ''))`;
  const templateModal = `${visibleModals}.find(m => /Template/.test(m.querySelector('.ant-modal-title')?.innerText ?? ''))`;
  const textarea = (id: string, value: string) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  // Picks by keyboard (focus, ArrowDown to open, ArrowDown to the option,
  // Enter): pointer clicks at coordinates raced antd's open animations and
  // toasts from earlier steps.
  const key = async (key: string, code: string, keyCode: number) => {
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode });
  };
  const activeOption = `document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-active')?.innerText.trim()`;
  const pickTemplate = async (name: string) => {
    await evaluate(`document.querySelector('.template-picker input').focus()`);
    await key('ArrowDown', 'ArrowDown', 40);
    await waitFor(() => evaluate(`!!(${activeOption})`), 'template dropdown open');
    for (let step = 0; step < 10 && await evaluate(activeOption) !== name; step++) await key('ArrowDown', 'ArrowDown', 40);
    assert.equal(await evaluate(activeOption), name, `template option ${name}`);
    await key('Enter', 'Enter', 13);
    await waitFor(() => evaluate(`document.querySelector('.template-picker .ant-select-content').innerText.trim() === ${JSON.stringify(name)}`), `picked ${name}`);
  };
  // What the form shows. prefix '' = instance form, 'template_' = template form.
  const formState = (prefix: string) => evaluate(`(() => {
    const el = id => document.getElementById(${JSON.stringify(prefix)} + id);
    return {
      id: el('id')?.value ?? null, templateName: el('templateName')?.value ?? null, name: el('name').value, cwd: el('cwd').value,
      executable: el('executable').value, args: el('args').value, stopCommand: el('stopCommand').value,
      restartDelayMs: el('restartDelayMs').value, stopTimeoutMs: el('stopTimeoutMs').value,
      autoStart: el('autoStart').getAttribute('aria-checked'),
      restartPolicy: el('restartPolicy').closest('.ant-select').innerText.trim()
    };
  })()`);
  const openCreateDialog = async () => {
    await evaluate(`Array.from(document.querySelectorAll('button')).find(el => el.innerText === 'Create Instance').click()`);
    await waitFor(() => evaluate(`!!${instanceModal}`), 'create dialog');
    await waitFor(() => evaluate(`!!document.querySelector('.template-picker')`), 'template picker');
  };
  const closeInstanceDialog = async () => {
    await evaluate(`Array.from(${instanceModal}.querySelectorAll('.ant-modal-footer button')).find(el => el.innerText.trim() === 'Cancel').click()`);
    await waitFor(() => evaluate(`!${instanceModal}`), 'instance dialog closes');
  };
  const submitTemplate = () => evaluate(`${templateModal}.querySelector('.ant-modal-footer .ant-btn-primary').click()`);
  const openDrawer = async () => {
    await evaluate(`document.querySelector('button[title="Instance templates"]').click()`);
    await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.ant-drawer')).some(d => d.innerText.includes('Instance templates') && !!d.querySelector('.ant-list-item'))`), 'templates drawer');
  };
  const drawerItem = (name: string) => `Array.from(document.querySelectorAll('.ant-drawer .ant-list-item')).find(item => item.querySelector('.ant-list-item-meta-title')?.innerText.trim() === ${JSON.stringify(name)})`;

  await openCreateDialog();
  await input('id', 'from-template');
  await pickTemplate('Castling');
  let state = await formState('');
  checkEqual('picking a template fills its fields and keeps the typed ID', state, {
    id: 'from-template', templateName: null, name: 'Castling server', cwd: '/srv/castling', executable: './rwr_server', args: '--a, --b',
    stopCommand: 'quit\n', restartDelayMs: '5000', stopTimeoutMs: '20000', autoStart: 'true', restartPolicy: 'On failure (non-zero exit or signal)'
  });
  await pickTemplate('Minimal');
  state = await formState('');
  checkEqual('switching template resets what the new one does not set to the defaults', state, {
    id: 'from-template', templateName: null, name: '', cwd: '.', executable: './other', args: '', stopCommand: '',
    restartDelayMs: '3000', stopTimeoutMs: '', autoStart: 'false', restartPolicy: 'Keep running (recommended for RWR)'
  });
  await input('cwd', '');
  await evaluate(`${instanceModal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}))`);
  await waitFor(() => evaluate(`!!document.getElementById('cwd').closest('.ant-form-item').querySelector('.ant-form-item-explain-error')`), 'cwd required error');
  await pickTemplate('Castling');
  await waitFor(() => evaluate(`!document.getElementById('cwd').closest('.ant-form-item').querySelector('.ant-form-item-explain-error')`), 'cwd error cleared', 3000).catch(() => false);
  check('applying a template clears the errors of the fields it refilled', await evaluate(`!document.getElementById('cwd').closest('.ant-form-item').querySelector('.ant-form-item-explain-error') && document.getElementById('cwd').value === '/srv/castling'`));
  const beforeTemplateCreate = requests.length;
  await clickSave();
  await waitFor(() => pending.length, 'create-from-template request');
  const fromTemplate = requests.at(-1)!.payload;
  check('create from a template sends one POST', requests.length === beforeTemplateCreate + 1);
  checkEqual('create from a template posts its values with the ID', fromTemplate, { ...castlingValues, id: 'from-template', autoRestart: true });
  await saved();

  // A hand-edited template with wrong types and foreign fields: the drawer
  // and the form show what is usable and drop the rest.
  await openCreateDialog();
  await input('id', 'from-broken');
  await pickTemplate('Broken');
  checkEqual('a malformed template fills only its well-typed fields', await formState(''), {
    id: 'from-broken', templateName: null, name: '', cwd: '.', executable: './bad', args: '', stopCommand: '',
    restartDelayMs: '3000', stopTimeoutMs: '', autoStart: 'false', restartPolicy: 'Keep running (recommended for RWR)'
  });

  // Save as template from the create dialog, then Escape: only the top dialog closes.
  await pickTemplate('Castling');
  await evaluate(`Array.from(${instanceModal}.querySelectorAll('.ant-modal-footer button')).find(el => el.innerText.includes('Save as template')).click()`);
  await waitFor(() => evaluate(`!!${templateModal}`), 'template dialog from create');
  await waitFor(() => evaluate(`${templateModal}.getAnimations({ subtree: true }).length === 0`), 'template dialog settles');
  checkEqual('save as template from the create dialog prefills its settings', await formState('template_'), {
    id: null, templateName: '', name: 'Castling server', cwd: '/srv/castling', executable: './rwr_server', args: '--a, --b', stopCommand: 'quit\n',
    restartDelayMs: '5000', stopTimeoutMs: '20000', autoStart: 'true', restartPolicy: 'On failure (non-zero exit or signal)'
  });
  await key('Escape', 'Escape', 27);
  await waitFor(() => evaluate(`!${templateModal}`), 'Escape closes the template dialog');
  check('Escape closes only the template dialog', await evaluate(`!!${instanceModal} && document.getElementById('id').value === 'from-broken'`));
  await closeInstanceDialog();

  // An instance whose Name is its ID (a blank Name at creation): the
  // template must not carry that ID as a name.
  await edit('created');
  await evaluate(`Array.from(${instanceModal}.querySelectorAll('.ant-modal-footer button')).find(el => el.innerText.includes('Save as template')).click()`);
  await waitFor(() => evaluate(`!!${templateModal}`), 'template dialog for created');
  check('a Name equal to the Instance ID is left out of the template', await evaluate(`document.getElementById('template_name').value === '' && document.getElementById('template_executable').value === './rwr_server'`));
  await key('Escape', 'Escape', 27);
  await waitFor(() => evaluate(`!${templateModal}`), 'template dialog closes');
  await closeInstanceDialog();

  // Save as template from an edit dialog: the instance's settings, never its ID.
  await edit('alpha');
  await evaluate(`Array.from(${instanceModal}.querySelectorAll('.ant-modal-footer button')).find(el => el.innerText.includes('Save as template')).click()`);
  await waitFor(() => evaluate(`!!${templateModal}`), 'template dialog');
  await waitFor(() => evaluate(`${templateModal}.getAnimations({ subtree: true }).length === 0`), 'template dialog settles');
  check('template dialog opens above the instance dialog', await evaluate(`(() => { const m = ${templateModal}; const r = m.querySelector('.ant-modal-container').getBoundingClientRect(); return m.contains(document.elementFromPoint(r.x + r.width / 2, r.y + 24)); })()`));
  checkEqual('template dialog is prefilled from the instance form without its ID', await formState('template_'), {
    id: null, templateName: '', name: 'alpha edited', cwd: '.', executable: 'unused', args: 'alpha', stopCommand: 'quit\n',
    restartDelayMs: '3000', stopTimeoutMs: '', autoStart: 'false', restartPolicy: 'Keep running (recommended for RWR)'
  });
  const beforeNameless = templateRequests.length;
  await submitTemplate();
  await waitFor(() => evaluate(`!!document.getElementById('template_templateName').closest('.ant-form-item').querySelector('.ant-form-item-explain-error')`), 'template name required');
  check('a template without a name is not sent', templateRequests.length === beforeNameless);
  await input('template_templateName', 'castling');
  // As a user would: last edits at the bottom, the name field scrolled away.
  await evaluate(`(() => { const field = document.getElementById('template_stopTimeoutMs'); field.focus(); field.scrollIntoView({ block: 'end' }); })()`);
  check('(setup) the name field is scrolled out of view and unfocused', await evaluate(`(() => { const name = document.getElementById('template_templateName'); const body = name.closest('.ant-modal-body'); return document.activeElement !== name && name.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1; })()`));
  await submitTemplate();
  await waitFor(() => evaluate(`document.getElementById('template_templateName').closest('.ant-form-item').innerText.includes('already exists')`), 'name taken error');
  await waitFor(() => evaluate(`(() => { const name = document.getElementById('template_templateName'); const body = name.closest('.ant-modal-body').getBoundingClientRect(); const r = name.getBoundingClientRect(); return document.activeElement === name && r.top >= body.top - 1 && r.bottom <= body.bottom + 1; })()`), 'name field focused and in view after 409');
  check('a taken name is reported on the name field and the dialog stays open', templateRequests.at(-1)!.method === 'POST' && await evaluate(`!!${templateModal} && !!${instanceModal}`));
  await input('template_templateName', 'Alpha tpl');
  await submitTemplate();
  await waitFor(() => evaluate(`!${templateModal}`), 'template dialog closes');
  checkEqual('saved template holds the instance settings only', templateRequests.at(-1)!.payload, {
    name: 'Alpha tpl', values: { name: 'alpha edited', cwd: '.', executable: 'unused', args: ['alpha'], autoStart: false, restartPolicy: 'always', restartDelayMs: 3000, stopCommand: 'quit\n' }
  });
  check('the instance dialog stays open with its values after saving a template', await evaluate(`!!${instanceModal} && document.getElementById('id').value === 'alpha' && document.getElementById('name').value === 'alpha edited'`));
  await closeInstanceDialog();

  // The templates drawer: edit, delete, create an instance from one, new.
  await openDrawer();
  check('drawer lists every template', await evaluate(`!!${drawerItem('Castling')} && !!${drawerItem('Minimal')} && !!${drawerItem('Alpha tpl')} && !!${drawerItem('Broken')}`));
  check('a malformed template is summarized by its usable fields', await evaluate(`${drawerItem('Broken')}.querySelector('.ant-list-item-meta-description').innerText.trim() === './bad'`));
  check('the drawer summary shows the Enter after quit', await evaluate(`${drawerItem('Castling')}.innerText.includes('stop: quit ⏎ ⏎') && ${drawerItem('Castling')}.innerText.includes('stop timeout 20000 ms')`));
  await evaluate(`${drawerItem('Minimal')}.querySelector('button[title="Edit template"]').click()`);
  await waitFor(() => evaluate(`!!${templateModal} && document.getElementById('template_templateName')?.value === 'Minimal'`), 'edit template dialog');
  checkEqual('editing shows only what the template sets', await formState('template_'), {
    id: null, templateName: 'Minimal', name: '', cwd: '', executable: './other', args: '', stopCommand: '',
    restartDelayMs: '', stopTimeoutMs: '', autoStart: 'false', restartPolicy: 'Not set'
  });
  await input('template_executable', './changed');
  await textarea('template_stopCommand', 'quit\n');
  await submitTemplate();
  await waitFor(() => evaluate(`!${templateModal}`), 'edit template closes');
  check('editing a template sends PUT for it', templateRequests.at(-1)!.method === 'PUT' && templateRequests.at(-1)!.route === '/api/templates/t-minimal');
  checkEqual('editing a template replaces it with the form values', templateRequests.at(-1)!.payload, { name: 'Minimal', values: { executable: './changed', stopCommand: 'quit\n' } });
  await waitFor(() => evaluate(`${drawerItem('Minimal')}.innerText.includes('./changed')`), 'drawer shows the edit');

  await evaluate(`${drawerItem('Alpha tpl')}.querySelector('button[title="Delete template"]').click()`);
  await waitFor(() => evaluate(`Array.from(document.querySelectorAll('.ant-popconfirm')).some(p => p.getBoundingClientRect().height > 0)`), 'delete confirm');
  await evaluate(`Array.from(document.querySelectorAll('.ant-popconfirm')).find(p => p.getBoundingClientRect().height > 0).querySelector('.ant-btn-primary').click()`);
  await waitFor(() => evaluate(`!${drawerItem('Alpha tpl')}`), 'deleted template leaves the list');
  check('deleting a template sends DELETE', templateRequests.at(-1)!.method === 'DELETE' && !templates.has(templateRequests.at(-1)!.route.split('/').at(-1)!));

  await evaluate(`Array.from(${drawerItem('Castling')}.querySelectorAll('button')).find(el => el.innerText.includes('Create instance')).click()`);
  await waitFor(() => evaluate(`!!${instanceModal} && document.getElementById('cwd')?.value === '/srv/castling'`), 'create from drawer');
  check('"Create instance" opens the create dialog filled from that template', await evaluate(`document.querySelector('.template-picker').innerText.includes('Castling') && document.getElementById('id').value === '' && document.getElementById('name').value === 'Castling server'`));
  await pickTemplate('Minimal');
  checkEqual('switching away from the drawer\'s template drops its values too', await formState(''), {
    id: '', templateName: null, name: '', cwd: '.', executable: './changed', args: '', stopCommand: 'quit\n',
    restartDelayMs: '3000', stopTimeoutMs: '', autoStart: 'false', restartPolicy: 'Keep running (recommended for RWR)'
  });
  await closeInstanceDialog();
  await openCreateDialog();
  checkEqual('a plain Create starts from the defaults again', await formState(''), {
    id: '', templateName: null, name: '', cwd: '.', executable: './rwr_server', args: '', stopCommand: '',
    restartDelayMs: '3000', stopTimeoutMs: '', autoStart: 'false', restartPolicy: 'Keep running (recommended for RWR)'
  });
  check('a plain Create has no template picked', await evaluate(`!document.querySelector('.template-picker').innerText.includes('Castling') && !document.querySelector('.template-picker').innerText.includes('Minimal')`));
  await closeInstanceDialog();

  await openDrawer();
  await evaluate(`Array.from(document.querySelectorAll('.ant-drawer button')).find(el => el.innerText.includes('New template')).click()`);
  await waitFor(() => evaluate(`!!${templateModal}`), 'new template dialog');
  checkEqual('a new template starts empty', await formState('template_'), {
    id: null, templateName: '', name: '', cwd: '', executable: '', args: '', stopCommand: '',
    restartDelayMs: '', stopTimeoutMs: '', autoStart: 'false', restartPolicy: 'Not set'
  });
  await input('template_templateName', '  Empty  ');
  templateGate.hold = true;
  const beforeEmpty = templateRequests.length;
  await submitTemplate();
  await waitFor(() => templateRequests.length > beforeEmpty, 'template request');
  await submitTemplate();
  await evaluate(`${templateModal}.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}))`);
  await sleep(250);
  check('a template save in flight makes one request', templateRequests.length === beforeEmpty + 1 && templateGate.held.length === 1);
  check('a template save in flight disables its fields and buttons', await evaluate(`document.getElementById('template_templateName').disabled && document.getElementById('template_cwd').disabled && Array.from(${templateModal}.querySelectorAll('.ant-modal-footer button')).find(el => el.innerText.trim() === 'Cancel').disabled && !!${templateModal}.querySelector('.ant-btn-loading')`));
  templateGate.release();
  await waitFor(() => evaluate(`!${templateModal}`), 'new template closes');
  checkEqual('an empty template posts no values (name trimmed)', templateRequests.at(-1)!.payload, { name: 'Empty', values: {} });
};

const cleanup = async (): Promise<string | undefined> => {
  stopping = true;
  let browserProblem: string | undefined;
  try {
    for (const item of pending.splice(0)) send(item.res, 'Fixture shutdown', 503);
    templateGate.release();
    browserProblem = await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server!.close(resolve));
    }
    if (work) {
      assert(work.startsWith(path.join(root, '.cache') + path.sep));
      fs.rmSync(work, { recursive: true, force: true });
    }
    if (originalFingerprint) assert.equal(fingerprint(), originalFingerprint, 'User config must not change');
    return browserProblem && `Cleanup failed: ${browserProblem}`;
  } catch (error) {
    return [browserProblem, `Cleanup failed: ${(error as Error).stack}`].filter(Boolean).join('; ');
  }
};

run(flow, {
  timeoutMs: FLOW_TIMEOUT_MS,
  cleanup,
  // The error itself is reported by the last test.
  onError: async () => {
    if (browser?.isOpen()) {
      if (browser.pageErrors.length > 0) console.error('Page errors:\n' + browser.pageErrors.join('\n---\n'));
      try { console.error('Page state:', await browser.evaluate(`JSON.stringify({text:document.body.innerText,resources:performance.getEntriesByType('resource').map(item=>item.name)})`)); } catch { /* preserve original failure */ }
    }
  }
});
