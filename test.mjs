#!/usr/bin/env node
/**
 * test.mjs — load index.js the way the sandbox does (CommonJS, host-supplied
 * react/@plugin-host) and exercise the send path without Bulwark in the loop.
 * Run: node test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = readFileSync(join(HERE, 'index.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`);
  }
}

const store = new Map();
const toasts = [];
const api = {
  plugin: { id: 'html-source', version: '1.0.0', settings: {} },
  storage: {
    async get(k) {
      return store.has(k) ? JSON.parse(store.get(k)) : null;
    },
    async set(k, v) {
      store.set(k, JSON.stringify(v));
    },
    async remove(k) {
      store.delete(k);
    },
    async keys() {
      return [...store.keys()];
    }
  },
  i18n: { t: (k) => k, has: () => false, locale: 'zh', getLocale: () => 'zh' },
  toast: {
    info: (m) => toasts.push(['info', m]),
    warning: (m) => toasts.push(['warning', m]),
    success: () => {},
    error: () => {}
  },
  log: { debug() {}, info() {}, warn() {}, error() {} },
  ui: { async setActions() {}, async togglePanel() {}, async openPanel() {}, print() {} },
  composer: { async getBody() { return { html: '<p>editor</p>', text: 'editor' }; } }
};

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect() {},
  useMemo() {},
  useRef() {},
  useState() {}
};
const kit = { Segmented: 'Segmented', Switch: 'Switch', Alert: 'Alert', Row: 'Row', Text: 'Text', Button: 'Button', Textarea: 'Textarea' };

const mod = { exports: {} };
const ctx = vm.createContext({
  module: mod,
  exports: mod.exports,
  require(id) {
    if (id === 'react') return React;
    if (id === '@plugin-host/ui') return kit;
    if (id === '@plugin-host') return api;
    throw new Error('unexpected require: ' + id);
  },
  console,
  TextEncoder,
  setTimeout,
  clearTimeout
});
// The host evaluates the bundle as a function with React and friends as
// parameters, so the test does the same -- a top-level `const React` would
// throw "Identifier 'React' has already been declared" in the real sandbox.
const WRAP = (code) =>
  '(function (module, exports, require, React, ReactDOM, JsxRuntime, console) {' +
  String.fromCharCode(10) + code + String.fromCharCode(10) + '})';
vm.runInContext(WRAP(CODE), ctx, { filename: 'index.js' })(
  mod, mod.exports, ctx.require, React, {}, {}, console
);

const plugin = mod.exports;
const hooks = plugin.hooks || {};

console.log('module shape');
ok(typeof plugin.activate === 'function', 'activate exported');
ok(plugin.slots && plugin.slots['plugin-dialog'], 'plugin-dialog slot declared');
ok(plugin.slots['plugin-dialog'].fill === true, 'dialog slot fills its frame');
ok(!plugin.slots['composer-sidebar'], 'no composer-sidebar panel any more');
ok(typeof hooks.onTransformOutgoingEmail === 'function', 'transform hook present');

const DOC = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>.a { color: #b00 }</style>
    <script>alert(1)</script>
  </head>
  <body>
    <table><tr><td class="a" onclick="steal()">body text</td></tr></table>
  </body>
</html>`;

const mail = {
  to: ['someone@example.com'],
  cc: [],
  bcc: [],
  subject: '测试 HTML',
  htmlBody: '<p>editor</p>',
  textBody: 'editor',
  identityId: 'i1',
  attachments: []
};

// The panel writes this record when the switch is on.
const arm = {
  html: '<table><tr><td class="a">body text</td></tr></table>',
  text: 'body text',
  subject: '测试 HTML',
  to: ['someone@example.com'],
  cc: [],
  bcc: [],
  at: Date.now()
};

console.log('transform: no arm record');
{
  const out = await hooks.onTransformOutgoingEmail({ ...mail });
  ok(out.htmlBody === '<p>editor</p>', 'untouched body when nothing armed');
  ok(toasts.some((x) => x[0] === 'warning'), 'warns that no source matched');
}

console.log('transform: armed');
{
  store.clear();
  toasts.length = 0;
  await api.storage.set('arm:c1', arm);
  const out = await hooks.onTransformOutgoingEmail({ ...mail });
  ok(out.htmlBody === arm.html, 'htmlBody replaced verbatim');
  ok(out.textBody === 'body text', 'plain part replaced');
  ok(out.subject === mail.subject && out.to[0] === mail.to[0], 'envelope untouched');
  ok(toasts.some((x) => x[0] === 'info'), 'says the source was used');
  ok((await api.storage.keys()).length === 0, 'record consumed');
}

console.log('transform: second send reuses nothing');
{
  const out = await hooks.onTransformOutgoingEmail({ ...mail });
  ok(out.htmlBody === '<p>editor</p>', 'falls back to the editor body');
}

console.log('transform: mismatched subject');
{
  store.clear();
  await api.storage.set('arm:c2', { ...arm, subject: '别的东西' });
  const out = await hooks.onTransformOutgoingEmail({ ...mail });
  ok(out.htmlBody === '<p>editor</p>', 'not applied to another subject');
}

console.log('transform: other recipient');
{
  store.clear();
  await api.storage.set('arm:c3', { ...arm, to: ['other@example.com'] });
  const out = await hooks.onTransformOutgoingEmail({ ...mail });
  ok(out.htmlBody === '<p>editor</p>', 'not applied to another recipient');
}

console.log('transform: expired / empty records are pruned');
{
  store.clear();
  await api.storage.set('arm:c4', { ...arm, at: 0 });
  await api.storage.set('arm:c5', { html: '   ', to: [], cc: [], bcc: [], subject: '测试 HTML', at: Date.now() });
  const out = await hooks.onTransformOutgoingEmail({ ...mail });
  ok(out.htmlBody === '<p>editor</p>', 'stale record ignored');
  ok((await api.storage.keys()).length === 0, 'stale records removed');
}

console.log('transform: replying to somebody with no subject match');
{
  store.clear();
  await api.storage.set('arm:c6', { ...arm, subject: '' , to: [] });
  const out = await hooks.onTransformOutgoingEmail({ ...mail });
  ok(out.htmlBody === arm.html, 'empty subject/recipients act as wildcards');
}

console.log('onAfterEmailSend clears the record');
{
  store.clear();
  await api.storage.set('arm:c7', arm);
  await hooks.onAfterEmailSend({ composerId: 'c7' });
  ok((await api.storage.keys()).length === 0, 'record dropped after send');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
