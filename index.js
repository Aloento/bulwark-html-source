'use strict';

/**
 * html-source — raw HTML editing for the Bulwark composer.
 *
 * No build step: the bundle is plain CommonJS that the host evaluates with
 * (module, exports, require). React and the UI kit come from the host, so the
 * only thing in the zip is this file and the manifest.
 *
 * How the HTML actually reaches the wire:
 *   onTransformOutgoingEmail (permission email:send, NOT privileged) returns a
 *   copy of the outgoing message whose htmlBody is exactly what you typed.
 *   email-composer.tsx feeds that straight into JMAP bodyValues, so nothing
 *   re-serialises it. The rich-text editor is bypassed entirely.
 */

// React is handed to the bundle as a parameter by the sandbox; requiring it here
// would redeclare that parameter and fail to parse.
const ReactLib = typeof React !== 'undefined' ? React : require('react');
const kit = require('@plugin-host/ui');
const api = require('@plugin-host');

const h = ReactLib.createElement;
const { useEffect, useMemo, useRef, useState } = React;

const Segmented = kit.Segmented;
const Switch = kit.Switch;
const Alert = kit.Alert;
const Badge = kit.Badge;
const Row = kit.Row;
const Text = kit.Text || 'span';
const Button = kit.Button || 'button';
const Textarea = kit.Textarea || 'textarea';
const Input = kit.Input || 'input';

// ─── storage keys ──────────────────────────────────────────────

const K_DRAFT = 'src:'; // src:<composerId>  -> { html, armed, at }   panel state
const K_ARM = 'arm:'; // arm:<composerId>  -> { html, text, subject, to, cc, bcc, at }
const ARM_TTL = 12 * 60 * 60 * 1000;

// A resend has no composer yet: the dialog opens first, the composer is created
// afterwards, so the record cannot be keyed by composerId. It is keyed by the
// subject instead and lives until the send hook eats it (or two hours pass).
const K_RESEND = 'resend:'; // resend:<gen> -> { html, subject, to, cc, at }
const RESEND_TTL = 2 * 60 * 60 * 1000;

// ─── i18n ──────────────────────────────────────────────────────

const FALLBACK = {
  'action.toggle': 'HTML 源码',
  'panel.title': 'HTML 源码',
  'view.source': '源码',
  'view.split': '分栏',
  'view.preview': '预览',
  'arm.label': '发送时用这段源码',
  'arm.notice': '这封邮件会以 HTML 源码原样发送：真正的内容是下方的源码，不是这段提示。想改内容请切回源码面板编辑，或关掉该开关。',
  'btn.pull': '读取正文',
  'btn.push': '写回正文',
  'note.pulled': '已从撰写器读取正文。',
  'note.pullEmpty': '撰写器正文是空的。',
  'note.pushed': '已写回撰写器。富文本编辑器会重新排版 HTML，要原样发送请保持开关开启。',
  'note.pushFailed': '写回失败。',
  'note.armFailed': '改不了撰写器正文，已把「发送时用这段源码」关掉。',
  'warn.script': '脚本、frame 与内联事件已移除，不会被发送。',
  'warn.remote': '有 {n} 张远程图片：收件端默认通常不加载。',
  'warn.size': '{kb} KB —— 超过 100 KB 部分客户端会截断。',
  'warn.empty': '还没有内容：读取正文，或直接粘贴 HTML。',
  'toast.injected': '已改用 HTML 源码发送。',
  'toast.noMatch': '没找到匹配这封邮件的源码（主题或收件人变了），发送的是编辑器正文。',
  'placeholder': '<!doctype html>\n<html>\n  <body>\n    <p>你好</p>\n  </body>\n</html>',
  'stat': '{chars} 字符 · {size}',
  'resend.action': '再次发送',
  'resend.actionDesc': '取这封邮件的原始 HTML，改完再发一次。',
  'resend.title': '再次发送',
  'resend.to': '收件人',
  'resend.cc': '抄送',
  'resend.subject': '主题',
  'resend.send': '在新撰写器中发送',
  'resend.needTo': '至少填一个收件人。',
  'resend.badTo': '这个地址不对：{addr}',
  'resend.none': '这封邮件里没有可用的 HTML 正文。',
  'resend.failed': '读不出这封邮件的原始内容。',
  'resend.plain': '这封邮件没有 HTML 版本，已用纯文本接手。',
  'resend.opened': '已在新撰写器里打开：正文是提示语，发出时会换成这段源码。',
  'resend.openFailed': '打开撰写器失败，源码已留在对话框里。',
  'resend.images': '内嵌图片已转成内联数据 {n} 张。',
  'resend.imagesSkipped': '{n} 张内嵌图片太大，没有带过来。',
  'toast.resend': '已按原始 HTML 发送（再次发送）。'
};

function t(key, vars) {
  let s = '';
  try {
    s = api.i18n && api.i18n.t ? api.i18n.t(key, vars) : '';
  } catch (e) {
    s = '';
  }
  if (!s || s === key) s = FALLBACK[key] || key;
  if (vars && typeof s === 'string') {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}

function say(level, msg) {
  try {
    if (api.toast && api.toast[level]) api.toast[level](msg);
  } catch (e) {
    /* a toast is not worth failing over */
  }
}

// ─── storage ───────────────────────────────────────────────────

async function sget(key) {
  try {
    return await api.storage.get(key);
  } catch (e) {
    return null;
  }
}
async function sset(key, val) {
  try {
    await api.storage.set(key, val);
    return true;
  } catch (e) {
    api.log.warn('storage.set failed: ' + key, e);
    return false;
  }
}
async function sdel(key) {
  try {
    await api.storage.remove(key);
  } catch (e) {
    /* nothing */
  }
}
async function skeys() {
  try {
    const keys = await api.storage.keys();
    return Array.isArray(keys) ? keys : [];
  } catch (e) {
    return [];
  }
}

// ─── addresses ─────────────────────────────────────────────────

function addrOf(v) {
  // JMAP gives { name, email } objects; composers hand over plain strings.
  if (v && typeof v === 'object') {
    return String(v.email || v.address || '').trim().toLowerCase();
  }
  const s = String(v == null ? '' : v).trim();
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
}

function addrList(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return [addrOf(v)].filter(Boolean);
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;]/);
  return arr.map(addrOf).filter(Boolean);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const x = a.slice().sort();
  const y = b.slice().sort();
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// ─── html helpers ──────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Drop what a mail client would drop anyway, plus inline handlers. */
function stripActive(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * A pasted full document becomes a body fragment, with the <head> styles
 * carried over — that is what people mean when they paste an .html file.
 */
function unwrapDocument(src) {
  let s = String(src || '');
  if (!/<!doctype|<html[\s>]|<body[\s>]/i.test(s)) return stripActive(s);

  let styles = '';
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(s);
  if (head) {
    const found = head[1].match(/<style[\s\S]*?<\/style>/gi);
    if (found) styles = found.join('\n');
  }

  let inner;
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(s);
  if (body) {
    inner = body[1];
  } else {
    inner = s
      .replace(/<!doctype[^>]*>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<\/?html[^>]*>/gi, '');
  }
  return stripActive(styles + '\n' + inner);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isEmptyHtml(html) {
  const s = String(html || '');
  if (/[^\s]/.test(s.replace(/<[^>]*>/g, ''))) return false;
  return !/<(img|table|hr|video)\b/i.test(s);
}

function inspect(html) {
  const s = String(html || '');
  let bytes = s.length;
  try {
    bytes = new TextEncoder().encode(s).length;
  } catch (e) {
    /* keep the character count */
  }
  return {
    chars: s.length,
    bytes: bytes,
    // An empty Tiptap body is "<p dir=\"auto\"></p>": structure, not content.
    empty: isEmptyHtml(s),
    remote: (s.match(/<img[^>]+src\s*=\s*["']?https?:/gi) || []).length,
    script: /<script[\s>]/i.test(s) || /<iframe[\s>]/i.test(s)
  };
}

function fmtBytes(n) {
  return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
}

const PREVIEW_CSS =
  'html,body{margin:0;padding:0;background:#fff}' +
  'body{padding:18px 20px;color:#111;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,' +
  '"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;word-break:break-word}' +
  'img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}a{color:#0b62d6}' +
  'pre{white-space:pre-wrap}';

function previewDoc(html) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    PREVIEW_CSS +
    '</style></head><body>' +
    unwrapDocument(html) +
    '</body></html>'
  );
}

// ─── raw message → HTML ────────────────────────────────────────
// The host hands over the stored message as bytes (api.email.getRaw). What we
// need back out of it is the text/html leaf, decoded byte for byte: parsing it
// through a DOM would normalise the markup we are here to preserve.

function binFromBuffer(buf) {
  let u;
  if (buf instanceof Uint8Array) u = buf;
  else if (buf && typeof buf.byteLength === 'number') u = new Uint8Array(buf);
  else if (typeof buf === 'string') return buf;
  else return '';
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u.length; i += CH) {
    s += String.fromCharCode.apply(null, u.subarray(i, Math.min(i + CH, u.length)));
  }
  return s;
}

function bytesOf(bin) {
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i) & 0xff;
  return u;
}

function decodeBin(bin, charset) {
  const label = String(charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '') || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytesOf(bin));
  } catch (e) {
    // Unknown label: UTF-8 with replacement characters beats losing the body.
    try {
      return new TextDecoder('utf-8').decode(bytesOf(bin));
    } catch (e2) {
      return bin;
    }
  }
}

function parseEntity(bin) {
  const headers = {};
  let last = '';
  let i = 0;
  while (i < bin.length) {
    let nl = bin.indexOf('\n', i);
    if (nl < 0) nl = bin.length;
    let line = bin.slice(i, nl);
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    i = nl + 1;
    if (!line) break;
    if ((line.charAt(0) === ' ' || line.charAt(0) === '\t') && last) {
      headers[last] = headers[last] + ' ' + line.trim();
      continue;
    }
    const at = line.indexOf(':');
    if (at > 0) {
      last = line.slice(0, at).trim().toLowerCase();
      headers[last] = line.slice(at + 1).trim();
    } else {
      last = '';
    }
  }
  return { headers: headers, body: bin.slice(i) };
}

function mediaType(value) {
  const s = String(value || '').trim().toLowerCase();
  const at = s.indexOf(';');
  return (at < 0 ? s : s.slice(0, at)).trim();
}

function headerParam(value, name) {
  const s = String(value || '');
  const re = new RegExp('(?:^|;)\\s*' + name + '\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))', 'i');
  const m = re.exec(s);
  if (!m) return '';
  return (m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]) || '';
}

function b64Decode(s) {
  const clean = String(s || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return '';
  try {
    return atob(clean);
  } catch (e) {
    return '';
  }
}

function qpDecode(s) {
  const src = String(s || '').replace(/=\r?\n/g, '');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (c === '=' && i + 2 < src.length) {
      const hex = src.slice(i + 1, i + 3);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out += c;
  }
  return out;
}

function transferBody(body, cte) {
  const e = String(cte || '').trim().toLowerCase();
  if (e === 'base64') return b64Decode(body);
  if (e === 'quoted-printable') return qpDecode(body);
  return String(body || '');
}

function splitMultipart(body, boundary) {
  const delim = '--' + boundary;
  const chunks = String(body || '').split(delim);
  const out = [];
  for (let i = 1; i < chunks.length; i++) {
    let c = chunks[i];
    if (c.slice(0, 2) === '--') break; // the closing delimiter
    if (c.slice(0, 2) === '\r\n') c = c.slice(2);
    else if (c.charAt(0) === '\n') c = c.slice(1);
    // The newline in front of the delimiter belongs to the delimiter.
    c = c.replace(/\r?\n$/, '');
    out.push(c);
  }
  return out;
}

function collectParts(bin, out, depth) {
  if ((depth || 0) > 12) return out;
  const ent = parseEntity(bin);
  const ctype = ent.headers['content-type'] || 'text/plain; charset=us-ascii';
  const type = mediaType(ctype);
  if (type.indexOf('multipart/') === 0) {
    const boundary = headerParam(ctype, 'boundary');
    if (!boundary) return out;
    const raws = splitMultipart(ent.body, boundary);
    for (let i = 0; i < raws.length; i++) collectParts(raws[i], out, (depth || 0) + 1);
    return out;
  }
  const charset = headerParam(ctype, 'charset') || 'utf-8';
  const raw = transferBody(ent.body, ent.headers['content-transfer-encoding']);
  out.push({ type: type, charset: charset, raw: raw, text: decodeBin(raw, charset), headers: ent.headers });
  return out;
}

/** The HTML body of a stored message; plain text is wrapped when there is none. */
function htmlFromRaw(ab) {
  const parts = collectParts(binFromBuffer(ab), [], 0);
  let html = null;
  let plain = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!html && p.type === 'text/html') html = p;
    if (!plain && p.type === 'text/plain') plain = p;
  }
  if (html && html.text.trim()) return { html: html.text, plain: false };
  if (plain && plain.text.trim()) {
    const body = esc(plain.text).replace(/\r\n/g, '\n').replace(/\n/g, '<br>\n');
    return {
      html:
        '<div style="font:14px/1.6 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'PingFang SC\',\'Microsoft YaHei\',sans-serif">' +
        body +
        '</div>',
      plain: true
    };
  }
  return { html: '', plain: true };
}

function escapeRe(s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cidKey(v) {
  const s = String(v || '').trim();
  const inner = /^<(.*)>$/.exec(s);
  let out = inner ? inner[1] : s;
  try {
    out = decodeURIComponent(out);
  } catch (e) {
    /* keep it raw */
  }
  return out.toLowerCase();
}

/**
 * An `src="cid:logo@x"` only renders while the blob is addressable. A resend
 * cannot keep the CID: the new message gets fresh part ids, so the pictures are
 * folded into the HTML as data: URIs instead.
 */
async function inflateInline(emailId, atts, html) {
  const list = (atts || []).filter(function (a) {
    return a && a.inline && a.cid && a.blobId;
  });
  const result = { html: html, used: 0, skipped: 0 };
  if (!list.length) return result;
  let budget = 3 * 1024 * 1024;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const needle = new RegExp('cid:' + escapeRe(cidKey(a.cid)), 'gi');
    if (!needle.test(result.html)) continue;
    try {
      const got = await api.email.getAttachment(emailId, a.blobId);
      const bin = binFromBuffer(got && got.data);
      if (!bin.length) {
        result.skipped++;
        continue;
      }
      if (bin.length > budget) {
        result.skipped++;
        continue;
      }
      budget -= bin.length;
      result.html = result.html.replace(needle, 'data:' + ((got && got.type) || a.type || 'image/png') + ';base64,' + btoa(bin));
      result.used++;
    } catch (e) {
      api.log.warn('inline image could not be read', e);
      result.skipped++;
    }
  }
  return result;
}

// ─── styles ────────────────────────────────────────────────────

const ROOT = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  height: '100%',
  // A dialog measures its frame from the content: without a floor the frame
  // collapses to 0 px and nothing is visible.
  minHeight: 420,
  padding: 10,
  boxSizing: 'border-box'
};

const PANE = { display: 'flex', flex: '1 1 0', minWidth: 0, minHeight: 0 };

const EDITOR = {
  flex: '1 1 0',
  width: '100%',
  height: '100%',
  minHeight: 0,
  resize: 'none',
  boxSizing: 'border-box',
  padding: '8px 10px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  tabSize: 2
};

const EMPTY_PANE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '1 1 0',
  minHeight: 0,
  border: '1px dashed rgba(127,127,127,0.24)',
  borderRadius: 6,
  padding: 16,
  textAlign: 'center'
};

const FRAME = {
  width: '100%',
  height: '100%',
  border: '1px solid rgba(127,127,127,0.28)',
  borderRadius: 8,
  background: '#ffffff'
};

// ─── panel ─────────────────────────────────────────────────────

function debouncedValue(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(function () {
      setV(value);
    }, ms);
    return function () {
      clearTimeout(id);
    };
  }, [value, ms]);
  return v;
}

async function composerBody(composerId) {
  try {
    return await api.composer.getBody(composerId);
  } catch (e) {
    api.log.warn('composer.getBody failed', e);
    return null;
  }
}

function SourcePanel(props) {
  const composerId = (props && props.composerId) || '';
  // mode 'resend': opened from a stored message, so there is no composer yet.
  // The recipients and subject are prefilled from the message and come back
  // through onResult, where the caller opens the composer and arms the send.
  const resendMode = !!(props && props.mode === 'resend');
  // A dialog slot gets no `draft` prop, so the composer's subject and
  // recipients are polled from the host instead: the arm record has to match
  // the message the send hook will see.
  const [meta, setMeta] = useState({ subject: '', to: [], cc: [], bcc: [] });
  useEffect(
    function () {
      if (!composerId) return undefined;
      let gone = false;
      const pull = async function () {
        try {
          const snap = await api.composer.getSnapshot(composerId);
          if (gone || !snap) return;
          setMeta({
            subject: String(snap.subject || ''),
            to: addrList(snap.to),
            cc: addrList(snap.cc),
            bcc: addrList(snap.bcc)
          });
        } catch (e) {
          /* the composer is not open (any more) */
        }
      };
      pull();
      const id = setInterval(pull, 2000);
      return function () {
        gone = true;
        clearInterval(id);
      };
    },
    [composerId]
  );
  const subject = meta.subject;
  const toList = meta.to;
  const ccList = meta.cc;
  const bccList = meta.bcc;
  const focusRequest = props && props.focusRequest;

  const [source, setSource] = useState(resendMode && props && typeof props.html === 'string' ? props.html : '');
  const [view, setView] = useState('split');
  const [armed, setArmed] = useState(resendMode);
  const [toText, setToText] = useState(resendMode ? String((props && props.to) || '') : '');
  const [ccText, setCcText] = useState(resendMode ? String((props && props.cc) || '') : '');
  const [subjText, setSubjText] = useState(resendMode ? String((props && props.subject) || '') : '');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const areaRef = useRef(null);

  // hydrate: saved source for this composer, else whatever the editor holds
  useEffect(function () {
    let gone = false;
    if (!composerId) {
      setReady(true);
      return undefined;
    }
    setReady(false);
    (async function () {
      const saved = await sget(K_DRAFT + composerId);
      if (gone) return;
      const rec = await sget(K_ARM + composerId);
      if (gone) return;
      if (saved && typeof saved.html === 'string') {
        setSource(saved.html);
        setArmed(!!saved.armed);
      } else {
        const body = await composerBody(composerId);
        if (gone) return;
        if (body && typeof body.html === 'string' && body.html.trim() && !isEmptyHtml(body.html)) {
          setSource(body.html);
        }
        setArmed(!!(rec && rec.html));
      }
      setReady(true);
    })();
    return function () {
      gone = true;
    };
  }, [composerId]);

  // persist the panel state (cheap, debounced)
  useEffect(
    function () {
      if (!ready || !composerId) return undefined;
      const id = setTimeout(function () {
        sset(K_DRAFT + composerId, { html: source, armed: !!armed, at: Date.now() });
      }, 200);
      return function () {
        clearTimeout(id);
      };
    },
    [ready, composerId, source, armed]
  );

  // keep the arm record in step with the source AND the draft metadata
  useEffect(
    function () {
      if (!ready || !composerId) return undefined;
      const id = setTimeout(function () {
        if (!armed || !source.trim()) {
          sdel(K_ARM + composerId);
          return;
        }
        const html = unwrapDocument(source);
        sset(K_ARM + composerId, {
          html: html,
          text: htmlToText(html),
          subject: subject,
          to: toList,
          cc: ccList,
          bcc: bccList,
          at: Date.now()
        });
      }, 250);
      return function () {
        clearTimeout(id);
      };
    },
    [ready, composerId, armed, source, meta]
  );

  // Arming has to be visible in the editor itself: what goes out is the source,
  // not the rich text on screen. The body is swapped for a one-line notice and
  // put back when the switch is turned off again.
  const bodySwap = useRef({ last: null, backup: '' });
  useEffect(
    function () {
      if (!ready || !composerId) return;
      if (bodySwap.current.last === armed) return;
      bodySwap.current.last = armed;
      (async function () {
        if (armed) {
          const body = await composerBody(composerId);
          if (body && typeof body.html === 'string' && body.html.trim()) {
            bodySwap.current.backup = body.html;
          }
          let ok = false;
          try {
            ok = await api.composer.replaceBody(composerId, { text: t('arm.notice') });
          } catch (e) {
            api.log.warn('replaceBody failed', e);
          }
          if (!ok) {
            setArmed(false);
            setNote(t('note.armFailed'));
          }
          return;
        }
        const backup = bodySwap.current.backup;
        bodySwap.current.backup = '';
        if (!backup) return;
        try {
          await api.composer.replaceBody(composerId, { html: backup });
        } catch (e) {
          api.log.warn('replaceBody failed', e);
        }
      })();
    },
    [ready, composerId, armed]
  );

  // the toolbar button asks for the caret
  useEffect(
    function () {
      if (focusRequest && areaRef.current) {
        try {
          areaRef.current.focus();
        } catch (e) {
          /* focus is a nicety */
        }
      }
    },
    [focusRequest]
  );

  const shown = debouncedValue(source, 220);
  const previewHtml = useMemo(
    function () {
      return previewDoc(shown);
    },
    [shown]
  );
  const info = useMemo(
    function () {
      return inspect(source);
    },
    [source]
  );

  const loadBody = async function () {
    if (!composerId) return;
    setBusy('pull');
    setNote('');
    try {
      const body = await composerBody(composerId);
      if (!body) {
        setNote(t('note.pullEmpty'));
        return;
      }
      let html = typeof body.html === 'string' ? body.html : '';
      if (!html.trim() && typeof body.text === 'string' && body.text.trim()) {
        html = '<p>' + esc(body.text).replace(/\n/g, '<br>') + '</p>';
      }
      if (!html.trim()) {
        setNote(t('note.pullEmpty'));
        return;
      }
      setSource(html);
      setNote(t('note.pulled'));
    } finally {
      setBusy('');
    }
  };

  const pushBody = async function () {
    if (!composerId) return;
    setBusy('push');
    setNote('');
    try {
      const ok = await api.composer.replaceBody(composerId, { html: unwrapDocument(source) });
      setNote(ok ? t('note.pushed') : t('note.pushFailed'));
    } catch (e) {
      api.log.warn('replaceBody failed', e);
      setNote(t('note.pushFailed'));
    } finally {
      setBusy('');
    }
  };

  const warnings = [];
  if (info.script) warnings.push(t('warn.script'));
  if (info.remote) warnings.push(t('warn.remote', { n: info.remote }));
  if (info.bytes > 100 * 1024) warnings.push(t('warn.size', { kb: Math.round(info.bytes / 1024) }));
  if (resendMode && props && props.inlined) warnings.push(t('resend.images', { n: props.inlined }));
  if (resendMode && props && props.skipped) warnings.push(t('resend.imagesSkipped', { n: props.skipped }));

  const fieldRow = resendMode
    ? h(
        'div',
        { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(Input, {
          value: toText,
          placeholder: t('resend.to'),
          spellCheck: false,
          onChange: function (e) {
            setToText(e.target.value);
          },
          style: { flex: '2 1 260px', minWidth: 0 }
        }),
        h(Input, {
          value: ccText,
          placeholder: t('resend.cc'),
          spellCheck: false,
          onChange: function (e) {
            setCcText(e.target.value);
          },
          style: { flex: '1 1 160px', minWidth: 0 }
        }),
        h(Input, {
          value: subjText,
          placeholder: t('resend.subject'),
          spellCheck: false,
          onChange: function (e) {
            setSubjText(e.target.value);
          },
          style: { flex: '2 1 240px', minWidth: 0 }
        })
      )
    : null;

  const submitResend = function () {
    const to = addrList(toText);
    const cc = addrList(ccText);
    if (!to.length) {
      setNote(t('resend.needTo'));
      return;
    }
    const all = to.concat(cc);
    for (let i = 0; i < all.length; i++) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(all[i])) {
        setNote(t('resend.badTo', { addr: all[i] }));
        return;
      }
    }
    if (typeof props.onResult !== 'function') return;
    props.onResult({
      to: to,
      cc: cc,
      subject: subjText.trim(),
      html: unwrapDocument(source),
      attachments: (props && props.attachments) || []
    });
  };

  const panes = h(
    'div',
    { style: { display: 'flex', gap: 8, flex: '1 1 0', minHeight: 0 } },
    view === 'preview'
      ? null
      : h(
          'div',
          { style: PANE },
          h(Textarea, {
            ref: areaRef,
            value: source,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: t('placeholder'),
            onChange: function (e) {
              setSource(e.target.value);
            },
            style: EDITOR
          })
        ),
    view === 'source'
      ? null
      : h(
          'div',
          { style: PANE },
          info.empty
            ? h(
                'div',
                { style: EMPTY_PANE },
                h(Text, { size: 'sm', tone: 'muted' }, t('view.empty'))
              )
            : h('iframe', {
                title: t('view.preview'),
                sandbox: '',
                srcDoc: previewHtml,
                style: FRAME
              })
        )
  );

  const button = function (label, onClick, isBusy, variant) {
    return h(
      Button,
      { key: label, size: 'sm', variant: variant || 'secondary', busy: !!isBusy, onClick: onClick },
      label
    );
  };

  const statLine = info.empty
    ? t('warn.empty')
    : t('stat', { chars: info.chars, size: fmtBytes(info.bytes) });

  return h(
    'div',
    { style: ROOT },
    h(
      Row,
      { justify: 'between', align: 'center', gap: 8, wrap: true },
      Segmented
        ? h(Segmented, {
            value: view,
            onChange: function (v) {
              setView(v);
            },
            options: [
              { value: 'source', label: t('view.source') },
              { value: 'split', label: t('view.split') },
              { value: 'preview', label: t('view.preview') }
            ]
          })
        : null,
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginLeft: 'auto',
            flexWrap: 'wrap'
          }
        },
        h(Text, { size: 'xs', tone: 'muted' }, statLine),
        resendMode
          ? h(
              Button,
              {
                size: 'sm',
                variant: 'primary',
                onClick: submitResend
              },
              t('resend.send')
            )
          : button(t('btn.pull'), loadBody, busy === 'pull', 'secondary'),
        resendMode ? null : button(t('btn.push'), pushBody, busy === 'push', 'primary'),
        armed && Badge ? h(Badge, { tone: 'success' }, t('arm.on')) : null,
        h(Text, { size: 'xs', tone: 'muted' }, t('arm.label')),
        Switch
          ? h(Switch, {
              checked: armed,
              disabled: resendMode,
              onChange: function (next) {
                setArmed(!!next);
              }
            })
          : null
      )
    ),
    note ? h(Text, { size: 'xs', tone: 'muted' }, note) : null,
    fieldRow,
    panes,
    warnings.length
      ? h(Alert, { tone: 'warning' }, h(Text, { size: 'xs' }, warnings.join('  ')))
      : null
  );
}

// ─── slots ─────────────────────────────────────────────────────

const slots = {
  // One big dialog, opened from the composer toolbar. (A composer-sidebar
  // panel was the first shape of this plugin; a 260 px column is too cramped
  // for HTML, so the panel is gone and the dialog is the only surface.)
  'plugin-dialog': {
    component: SourcePanel,
    fill: true
  }
};

// ─── hooks ─────────────────────────────────────────────────────

async function findArm(email) {
  const keys = await skeys();
  const armKeys = keys.filter(function (k) {
    return typeof k === 'string' && k.indexOf(K_ARM) === 0;
  });
  if (!armKeys.length) return null;

  const now = Date.now();
  const to = addrList(email && email.to);
  const cc = addrList(email && email.cc);
  const subject = String((email && email.subject) || '').trim();

  for (const key of armKeys) {
    const rec = await sget(key);
    if (!rec || typeof rec.html !== 'string' || !rec.html.trim()) {
      await sdel(key);
      continue;
    }
    if (now - (rec.at || 0) > ARM_TTL) {
      await sdel(key);
      continue;
    }
    const toOk = rec.to && rec.to.length ? sameSet(rec.to, to) : true;
    const ccOk = rec.cc && rec.cc.length ? sameSet(rec.cc, cc) : true;
    const subjOk = !rec.subject || !subject || rec.subject.trim() === subject;
    if (toOk && ccOk && subjOk) return { key: key, rec: rec };
  }
  return null;
}

/**
 * A resend record has to survive the composer being opened with it, and the
 * composer is created after the dialog closes. Matching is by subject only:
 * that is the one field the user is most likely to keep, and it is what lets
 * them rewrite the recipients (or add some) in the composer before sending.
 */
async function findResend(email) {
  const keys = (await skeys()).filter(function (k) {
    return typeof k === 'string' && k.indexOf(K_RESEND) === 0;
  });
  if (!keys.length) return null;
  const now = Date.now();
  const subject = String((email && email.subject) || '').trim();
  for (const key of keys) {
    const rec = await sget(key);
    if (!rec || typeof rec.html !== 'string' || !rec.html.trim()) {
      await sdel(key);
      continue;
    }
    if (now - (rec.at || 0) > RESEND_TTL) {
      await sdel(key);
      continue;
    }
    if (!subject || String(rec.subject || '').trim() !== subject) continue;
    return { key: key, rec: rec };
  }
  return null;
}

async function transformOutgoing(email) {
  const msg = email || {};
  let hit = await findArm(msg);
  let viaResend = false;
  if (!hit) {
    hit = await findResend(msg);
    viaResend = !!hit;
  }
  if (!hit) {
    say('warning', t('toast.noMatch'));
    return msg;
  }
  await sdel(hit.key);
  const html = hit.rec.html;
  const text = hit.rec.text || htmlToText(html);
  say('info', viaResend ? t('toast.resend') : t('toast.injected'));
  const next = {};
  for (const k in msg) next[k] = msg[k];
  next.htmlBody = html;
  next.textBody = text;
  return next;
}

// ─── resend ────────────────────────────────────────────────────

async function startResend(ev) {
  const emailId = ev && ev.context && ev.context.emailId;
  if (!emailId || !api.email || typeof api.email.getRaw !== 'function') {
    say('error', t('resend.failed'));
    return;
  }
  let view = null;
  try {
    view = await api.email.get(emailId);
  } catch (e) {
    api.log.warn('email.get failed', e);
  }
  let raw = null;
  try {
    raw = await api.email.getRaw(emailId);
  } catch (e) {
    api.log.warn('email.getRaw failed', e);
  }
  if (!raw) {
    say('error', t('resend.failed'));
    return;
  }
  const parsed = htmlFromRaw(raw);
  if (!parsed.html.trim()) {
    say('warning', t('resend.none'));
    return;
  }
  if (parsed.plain) say('info', t('resend.plain'));

  const atts = ((view && view.attachments) || []).filter(function (a) {
    return a && a.blobId;
  });
  const inlined = await inflateInline(emailId, atts, parsed.html);
  const carry = atts
    .filter(function (a) {
      return !a.inline && a.blobId;
    })
    .map(function (a) {
      return { blobId: a.blobId, name: a.name, type: a.type, size: a.size };
    });

  const res = await api.ui.openDialog({
    title: t('resend.title'),
    slot: 'plugin-dialog',
    extraProps: {
      mode: 'resend',
      html: inlined.html,
      subject: String((view && view.subject) || ''),
      to: addrList(view && view.to).join(', '),
      cc: addrList(view && view.cc).join(', '),
      attachments: carry,
      inlined: inlined.used,
      skipped: inlined.skipped
    },
    width: 1040,
    fill: true
  });
  if (!res || typeof res.html !== 'string' || !res.html.trim()) return;

  const to = addrList(res.to);
  const cc = addrList(res.cc);
  if (!to.length) {
    say('warning', t('resend.needTo'));
    return;
  }
  const bad = to.concat(cc).filter(function (a) {
    return !EMAIL_RE.test(a);
  });
  if (bad.length) {
    say('warning', t('resend.badTo', { addr: bad[0] }));
    return;
  }

  const key = K_RESEND + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = { html: res.html, subject: String(res.subject || ''), to: to, cc: cc, at: Date.now() };
  if (!(await sset(key, rec))) {
    say('error', t('resend.openFailed'));
    return;
  }
  try {
    await api.compose.open({
      to: to,
      cc: cc,
      subject: rec.subject,
      body: t('arm.notice'),
      attachments: Array.isArray(res.attachments) && res.attachments.length ? res.attachments : carry
    });
    say('info', t('resend.opened'));
  } catch (e) {
    api.log.error('compose.open failed', e);
    await sdel(key);
    say('error', t('resend.openFailed'));
  }
}

const hooks = {
  async onTransformOutgoingEmail(email) {
    try {
      return await transformOutgoing(email);
    } catch (e) {
      api.log.error('html-source transform failed', e);
      return email;
    }
  },

  async onAfterEmailSend(payload) {
    try {
      const id = payload && payload.composerId;
      if (id) await sdel(K_ARM + id);
    } catch (e) {
      /* the record also expires on its own */
    }
  },

  async onAction(ev) {
    if (!ev) return;
    if (ev.actionId === 'html-source.toggle') {
      const composerId = ev.context && ev.context.composerId;
      try {
        await api.ui.openDialog({
          title: t('panel.title'),
          slot: 'plugin-dialog',
          extraProps: { composerId: composerId || '' },
          width: 1040,
          fill: true
        });
      } catch (e) {
        api.log.warn('openDialog failed', e);
      }
      return;
    }
    if (ev.actionId === 'html-source.resend') {
      try {
        await startResend(ev);
      } catch (e) {
        api.log.error('resend failed', e);
        say('error', t('resend.failed'));
      }
    }
  }
};

// ─── activate ──────────────────────────────────────────────────

async function activate() {
  try {
    await api.ui.setActions('composer-toolbar-actions', [
      {
        id: 'html-source.toggle',
        label: t('action.toggle'),
        icon: 'code',
        description: t('action.toggleDesc')
      }
    ]);
  } catch (e) {
    api.log.warn('setActions failed', e);
  }
  try {
    await api.ui.setActions('reader-actions', [
      {
        id: 'html-source.resend',
        label: t('resend.action'),
        icon: 'send',
        description: t('resend.actionDesc')
      }
    ]);
  } catch (e) {
    api.log.warn('setActions (reader-actions) failed', e);
  }
}

module.exports = {
  activate: activate,
  slots: slots,
  hooks: hooks,
  // Reached by test.mjs only; the host reads activate/slots/hooks and ignores
  // anything else the bundle exports.
  _test: {
    htmlFromRaw: htmlFromRaw,
    parseEntity: parseEntity,
    collectParts: collectParts,
    headerParam: headerParam,
    qpDecode: qpDecode,
    b64Decode: b64Decode,
    mediaType: mediaType,
    cidKey: cidKey,
    findResend: findResend,
    transformOutgoing: transformOutgoing,
    K_RESEND: K_RESEND
  }
};
