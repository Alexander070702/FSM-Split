'use strict';
// End-to-end test of EvoSplit's real logic against a fully mocked UI5 + FSM.
// Run: node test/run.js
const fs = require('fs');
const assert = require('assert');
const path = require('path');

// ---- 1. extract the inline application script from index.html -------------
const html = fs.readFileSync(path.join(__dirname, '..', 'webapp', 'index.html'), 'utf8');
const anchor = html.indexOf('sap.ui.getCore().attachInit');
const start = html.lastIndexOf('<script>', anchor) + '<script>'.length;
const end = html.indexOf('</script>', anchor);
const appCode = html.slice(start, end);

// ---- 2. mocks -------------------------------------------------------------
let capturedInit = null;
const toasts = [];
const boxes = [];
let CREATED = [];
let INSIDE = true;
let CONTEXT = {
  cloudHost: 'eu.fsm.cloud.sap', account: 'ACC', company: 'COMP',
  auth: { access_token: 'TOK' }, selectedServiceCall: 'SC1', selectedActivities: { id: 'ACT_LONG' }
};

// minimal real JSONModel with path get/set (supports "/a/0/b")
class JSONModel {
  constructor(d) { this._d = d || {}; }
  _parent(path) {
    const keys = path.split('/').filter(Boolean);
    let o = this._d;
    for (let i = 0; i < keys.length - 1; i++) { o = o[keys[i]]; }
    return { o, last: keys[keys.length - 1] };
  }
  getProperty(path) {
    const keys = path.split('/').filter(Boolean);
    let o = this._d;
    for (const k of keys) { if (o == null) return undefined; o = o[k]; }
    return o;
  }
  setProperty(path, v) { const { o, last } = this._parent(path); o[last] = v; }
}

function makeChain() {
  const target = function () { return p; };
  const p = new Proxy(target, {
    get(t, prop) { if (prop === 'then') return undefined; return () => p; },
    apply() { return p; }
  });
  return p;
}
const Ctor = function () { return makeChain(); };
const MT = { show: (m) => toasts.push(m) };
const MB = { warning: (m) => boxes.push(['w', m]), error: (m) => boxes.push(['e', m]), information: (m) => boxes.push(['i', m]) };

const sdk = {
  _h: {},
  on(ev, cb) { this._h[ev] = cb; },
  emit(ev) { if (this._h[ev]) this._h[ev](JSON.stringify(CONTEXT)); }
};

global.sap = {
  m: new Proxy({}, { get(t, p) { if (p === 'MessageToast') return MT; if (p === 'MessageBox') return MB; return Ctor; } }),
  ui: {
    getCore: () => ({ attachInit: (f) => { capturedInit = f; } }),
    layout: { form: new Proxy({}, { get: () => Ctor }) },
    core: new Proxy({}, { get: () => Ctor }),
    model: { json: { JSONModel } }
  }
};
global.parent = {};
global.window = { __EVOSPLIT_TEST__: true };
global.FSMShell = {
  ShellSdk: { isInsideShell: () => INSIDE, init: () => sdk },
  SHELL_EVENTS: { Version1: { REQUIRE_CONTEXT: 'REQUIRE_CONTEXT' } }
};
global.window.FSMShell = global.FSMShell;

global.fetch = function (url, opts) {
  if (url.indexOf('config.json') >= 0)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ activityDtoVersion: '40', personDtoVersion: '26', clientId: 'evosplit' }) });
  if (url.indexOf('/api/query/v1') >= 0) {
    const q = JSON.parse(opts.body).query;
    if (q.indexOf('FROM Person') >= 0)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [
        { person: { id: 'T1', firstName: 'Max', lastName: 'Muster' } },
        { person: { id: 'T2', firstName: 'Anna', lastName: 'Berg' } }
      ] }) });
    if (q.indexOf('FROM Activity') >= 0)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [
        { activity: { id: 'ACT_LONG', code: 'A100', subject: 'Repair pump', durationInMinutes: 6000, serviceCall: 'SC1' } }
      ] }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
  }
  if (url.indexOf('/api/data/v4/Activity') >= 0) {
    CREATED.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ data: { activity: { id: 'new' } } })) });
  }
  return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('not found') });
};

const tick = () => new Promise((r) => setImmediate(r));

// ---- 3. run ----------------------------------------------------------------
(async function () {
  let passed = 0;
  const check = (name, fn) => { try { fn(); console.log('  \u2713', name); passed++; } catch (e) { console.error('  \u2717', name, '\n    ', e.message); process.exitCode = 1; } };

  // execute the app code -> registers init via mocked attachInit
  eval(appCode);
  assert(capturedInit, 'attachInit was not called');
  capturedInit();                 // builds the whole UI (throws on any bad control/typo)
  for (let i = 0; i < 8; i++) await tick();  // let config + shell handshake + loaders settle

  const api = global.window.__evosplit;
  assert(api, 'test seam missing');

  console.log('shell connect + data loading');
  check('detected inside shell', () => assert.strictEqual(api.isInShell(), true));
  check('context token captured', () => assert.strictEqual(api.getCtx().token, 'TOK'));
  check('technicians loaded (2)', () => assert.strictEqual(api.oModel.getProperty('/technicians').length, 2));
  check('activities loaded (1)', () => assert.strictEqual(api.oModel.getProperty('/activities').length, 1));

  console.log('activity selection prefills the form');
  check('serviceCall prefilled from activity', () => assert.strictEqual(api.oModel.getProperty('/serviceCall'), 'SC1'));
  check('sourceActivity set', () => assert.strictEqual(api.oModel.getProperty('/sourceActivity'), 'ACT_LONG'));
  check('totalWork = 6000min/60 = 100h', () => assert.strictEqual(api.oModel.getProperty('/totalWork'), 100));

  console.log('split & assign — sequential 10/30/40 with technicians');
  api.oModel.setProperty('/mode', 'sequential');
  api.oModel.setProperty('/parts', [
    { label: 'Mechanics', value: 10, technicianId: 'T1', technicianName: 'Max Muster' },
    { label: 'Electrics', value: 30, technicianId: 'T2', technicianName: 'Anna Berg' },
    { label: 'Assembly', value: 40, technicianId: '', technicianName: '' }
  ]);
  CREATED = [];
  await api.onSplit();
  check('created 3 activities', () => assert.strictEqual(CREATED.length, 3));
  check('all under service call SC1', () => assert(CREATED.every((a) => a.serviceCall === 'SC1')));
  check('type ASSIGNMENT', () => assert(CREATED.every((a) => a.type === 'ASSIGNMENT')));
  check('durations 600/1800/2400 min', () => assert.deepStrictEqual(CREATED.map((a) => a.durationInMinutes), [600, 1800, 2400]));
  check('technician T1 assigned to piece 1', () => assert.deepStrictEqual(CREATED[0].responsibles, ['T1']));
  check('technician T2 assigned to piece 2', () => assert.deepStrictEqual(CREATED[1].responsibles, ['T2']));
  check('piece 3 has no responsibles', () => assert.strictEqual(CREATED[2].responsibles, undefined));
  check('externalId links back to source activity', () => assert(CREATED[0].externalId.indexOf('ACT_LONG') >= 0));
  check('success toast shown', () => assert(toasts.some((t) => /Created & assigned 3/.test(t))));

  console.log('split & assign — percentage 60/20/20 of 100h');
  api.oModel.setProperty('/mode', 'percentage');
  api.oModel.setProperty('/totalWork', 100);
  api.oModel.setProperty('/parts', [
    { label: 'Crew A', value: 60, technicianId: 'T1', technicianName: 'Max Muster' },
    { label: 'Crew B', value: 20, technicianId: 'T2', technicianName: 'Anna Berg' },
    { label: 'Crew C', value: 20, technicianId: 'T1', technicianName: 'Max Muster' }
  ]);
  CREATED = [];
  await api.onSplit();
  check('durations 3600/1200/1200 min', () => assert.deepStrictEqual(CREATED.map((a) => a.durationInMinutes), [3600, 1200, 1200]));
  check('sum of work = 100h (6000 min)', () => assert.strictEqual(CREATED.reduce((s, a) => s + a.durationInMinutes, 0), 6000));

  console.log('dry run creates nothing');
  api.oModel.setProperty('/mode', 'sequential');
  api.oModel.setProperty('/dryRun', true);
  CREATED = [];
  await api.onSplit();
  check('no activities created on dry run', () => assert.strictEqual(CREATED.length, 0));
  check('result table still populated', () => assert.strictEqual(api.oResultModel.getProperty('/items').length, 3));

  console.log('validation rejects bad percentage');
  api.oModel.setProperty('/dryRun', false);
  api.oModel.setProperty('/mode', 'percentage');
  api.oModel.setProperty('/parts', [{ label: 'A', value: 50, technicianId: '', technicianName: '' }, { label: 'B', value: 30, technicianId: '', technicianName: '' }]);
  CREATED = []; const before = boxes.length;
  await api.onSplit();
  check('rejected (warning) and nothing created', () => { assert.strictEqual(CREATED.length, 0); assert(boxes.length > before); });

  console.log(`\n${passed} checks passed.`);
})();
