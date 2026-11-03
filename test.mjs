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
  ui: {
    async setActions(surface, actions) {
      (api.actions[surface] = api.actions[surface] || []).push(...actions);
    },
    async togglePanel() {
      return null;
    },
    async openPanel() {},
    async openDialog(opts) {
      api.dialogs.push(opts);
      return api.dialogResult;
    },
    print() {}
  },
  composer: { async getBody() { return { html: '<p>editor</p>', text: 'editor' }; } },
  email: {
    async get() {
      return api.message;
    },
    async getRaw() {
      return api.raw;
    },
    async getAttachment(id, blobId) {
      return { name: blobId, type: 'image/png', size: 3, data: new Uint8Array([1, 2, 3]).buffer };
    }
  },
  compose: {
    async open(opts) {
      api.opened.push(opts);
      return 'navigated';
    }
  },
  actions: {},
  dialogs: [],
  dialogResult: null,
  opened: [],
  message: null,
  raw: null
};

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect() {},
  useMemo() {},
  useRef() {},
  useState() {}
};
const kit = {
  Segmented: 'Segmented',
  Switch: 'Switch',
  Alert: 'Alert',
  Row: 'Row',
  Text: 'Text',
  Button: 'Button',
  Textarea: 'Textarea',
  Input: 'Input'
};

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
  TextDecoder,
  atob,
  btoa,
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

console.log('activate registers both surfaces');
{
  await plugin.activate();
  const bar = api.actions['composer-toolbar-actions'] || [];
  const reader = api.actions['reader-actions'] || [];
  ok(bar.length === 1 && bar[0].id === 'html-source.toggle', 'composer toolbar action');
  ok(reader.length === 1 && reader[0].id === 'html-source.resend', 'reader action');
  ok(/^[A-Za-z0-9-]{1,40}$/.test(reader[0].icon), 'reader icon name is legal');
}

// ─── raw MIME ──────────────────────────────────────────────────

const T = plugin._test;
const rawOf = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

console.log('mime: multipart/alternative, base64 UTF-8');
{
  const html = '<div style="color:#b00">你好，报价单</div>';
  const raw = [
    'From: a@example.com',
    'Subject: =?utf-8?B?5oql5Lu35Y2V?=',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('你好，报价单', 'utf8').toString('base64'),
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    '--b1--',
    ''
  ].join('\r\n');
  const out = T.htmlFromRaw(rawOf(raw));
  ok(out.html === html, 'html body decoded verbatim');
  ok(out.plain === false, 'not flagged as plain-only');
}

console.log('mime: quoted-printable + iso-8859-1');
{
  const raw = [
    'Content-Type: text/html; charset=iso-8859-1',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>caf=E9 =E0 Paris</p>'
  ].join('\r\n');
  const out = T.htmlFromRaw(rawOf(raw));
  ok(out.html === '<p>café à Paris</p>', 'QP bytes decoded with the part charset', JSON.stringify(out.html));
}

console.log('mime: nested multipart/mixed finds the html leaf');
{
  const html = '<table><tr><td>inner</td></tr></table>';
  const raw = [
    'Content-Type: multipart/mixed; boundary=outer',
    '',
    '--outer',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain fallback',
    '--outer',
    'Content-Type: multipart/alternative; boundary=inner',
    '',
    '--inner',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'inner text',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '--inner--',
    '--outer--',
    ''
  ].join('\r\n');
  const out = T.htmlFromRaw(rawOf(raw));
  ok(out.html === html, 'deep html preferred over the plain siblings');
}

console.log('mime: text/plain only is wrapped, not dropped');
{
  const raw = ['Content-Type: text/plain; charset=utf-8', '', '第一行', '第二行 <b>'].join('\r\n');
  const out = T.htmlFromRaw(rawOf(raw));
  ok(out.plain === true, 'flagged plain');
  ok(out.html.indexOf('第一行<br>') >= 0, 'line breaks kept');
  ok(out.html.indexOf('&lt;b&gt;') >= 0, 'text escaped, not treated as markup');
}

console.log('mime: helper edges');
{
  ok(T.mediaType('Multipart/Alternative; boundary=x') === 'multipart/alternative', 'media type lowercased');
  ok(T.headerParam('text/plain; charset="utf-8"', 'charset') === 'utf-8', 'quoted param');
  ok(T.b64Decode('aGVs\nbG8=') === 'hello', 'base64 with line breaks');
  ok(T.qpDecode('a=\r\nb') === 'ab', 'soft line break');
  ok(T.cidKey('<Logo@X>') === 'logo@x', 'cid normalised');
}

// ─── resend ────────────────────────────────────────────────────

console.log('resend: matching ignores the recipients');
{
  store.clear();
  toasts.length = 0;
  const html = '<div style="border:2px solid #0a0">raw</div>';
  await api.storage.set('resend:r1', { html, subject: '报价单 3 月', to: ['old@example.com'], cc: [], at: Date.now() });
  const out = await hooks.onTransformOutgoingEmail({
    ...mail,
    subject: '报价单 3 月',
    to: ['new@example.com'],
    htmlBody: '<p>notice</p>'
  });
  ok(out.htmlBody === html, 'source wins although the recipient changed');
  ok(toasts.some((x) => x[0] === 'info' && x[1].indexOf('HTML') >= 0), 'resend toast');
  ok((await api.storage.keys()).length === 0, 'record consumed');
}

console.log('resend: a different subject is not hijacked');
{
  store.clear();
  const html = '<div>raw</div>';
  await api.storage.set('resend:r2', { html, subject: '报价单 3 月', to: [], cc: [], at: Date.now() });
  const out = await hooks.onTransformOutgoingEmail({ ...mail, subject: '别的东西' });
  ok(out.htmlBody === '<p>editor</p>', 'other subjects keep the editor body');
  ok((await api.storage.keys()).length === 1, 'record survives for its own subject');
}

console.log('resend: expired records are pruned');
{
  store.clear();
  await api.storage.set('resend:r3', { html: '<div>raw</div>', subject: '测试 HTML', to: [], cc: [], at: 0 });
  const out = await hooks.onTransformOutgoingEmail({ ...mail });
  ok(out.htmlBody === '<p>editor</p>', 'stale resend ignored');
  ok((await api.storage.keys()).length === 0, 'stale resend removed');
}

console.log('resend: action reads the message and opens the composer');
{
  store.clear();
  api.dialogs.length = 0;
  api.opened.length = 0;
  const html = '<section><h1 style="color:#c00">RAW</h1></section>';
  const raw = ['Content-Type: text/html; charset=utf-8', '', html].join('\r\n');
  api.raw = rawOf(raw);
  api.message = {
    subject: '季度报价',
    to: [{ name: 'A', email: 'a@example.com' }],
    cc: [],
    attachments: [{ blobId: 'b1', name: 'p.pdf', type: 'application/pdf', size: 10, inline: false }]
  };
  api.dialogResult = { to: 'b@example.com, c@example.com', cc: '', subject: '季度报价', html };
  await hooks.onAction({ actionId: 'html-source.resend', context: { emailId: 'e1' } });
  const dlg = api.dialogs[0];
  ok(!!dlg && dlg.extraProps.mode === 'resend', 'dialog opened in resend mode');
  ok(!!dlg && dlg.extraProps.html === html, 'raw html handed to the dialog');
  ok(!!dlg && dlg.extraProps.to === 'a@example.com', 'recipients prefilled from the message');
  ok(api.opened.length === 1, 'composer opened once');
  const opened = api.opened[0];
  ok(JSON.stringify(opened.to) === JSON.stringify(['b@example.com', 'c@example.com']), 'user-edited recipients win');
  ok(opened.body !== html && opened.body.length > 0, 'composer body is the notice, not the html');
  ok(opened.attachments.length === 1 && opened.attachments[0].blobId === 'b1', 'attachments carried over');
  const keys = (await api.storage.keys()).filter((k) => k.indexOf('resend:') === 0);
  ok(keys.length === 1, 'resend record armed for the send hook');
}

console.log('resend: cancelling the dialog arms nothing');
{
  store.clear();
  api.dialogs.length = 0;
  api.opened.length = 0;
  api.dialogResult = null;
  await hooks.onAction({ actionId: 'html-source.resend', context: { emailId: 'e1' } });
  ok(api.opened.length === 0, 'no composer without a result');
  ok((await api.storage.keys()).length === 0, 'nothing left behind');
}

console.log('resend: a bad recipient is refused before any composer opens');
{
  store.clear();
  api.dialogs.length = 0;
  api.opened.length = 0;
  api.dialogResult = { to: 'not-an-address', cc: '', subject: 'x', html: '<p>x</p>' };
  await hooks.onAction({ actionId: 'html-source.resend', context: { emailId: 'e1' } });
  ok(api.opened.length === 0, 'composer stays closed');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
