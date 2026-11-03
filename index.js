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

// ─── storage keys ──────────────────────────────────────────────

const K_DRAFT = 'src:'; // src:<composerId>  -> { html, armed, at }   panel state
const K_ARM = 'arm:'; // arm:<composerId>  -> { html, text, subject, to, cc, bcc, at }
const ARM_TTL = 12 * 60 * 60 * 1000;

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
  'stat': '{chars} 字符 · {size}'
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
  const s = String(v == null ? '' : v).trim();
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
}

function addrList(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;]/);
  return arr.map(addrOf).filter(Boolean);
}

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

  const [source, setSource] = useState('');
  const [view, setView] = useState('split');
  const [armed, setArmed] = useState(false);
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
        button(t('btn.pull'), loadBody, busy === 'pull', 'secondary'),
        button(t('btn.push'), pushBody, busy === 'push', 'primary'),
        armed && Badge ? h(Badge, { tone: 'success' }, t('arm.on')) : null,
        h(Text, { size: 'xs', tone: 'muted' }, t('arm.label')),
        Switch
          ? h(Switch, {
              checked: armed,
              onChange: function (next) {
                setArmed(!!next);
              }
            })
          : null
      )
    ),
    note ? h(Text, { size: 'xs', tone: 'muted' }, note) : null,
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

async function transformOutgoing(email) {
  const msg = email || {};
  const hit = await findArm(msg);
  if (!hit) {
    say('warning', t('toast.noMatch'));
    return msg;
  }
  await sdel(hit.key);
  const html = hit.rec.html;
  const text = hit.rec.text || htmlToText(html);
  say('info', t('toast.injected'));
  const next = {};
  for (const k in msg) next[k] = msg[k];
  next.htmlBody = html;
  next.textBody = text;
  return next;
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
    if (!ev || ev.actionId !== 'html-source.toggle') return;
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
}

module.exports = { activate: activate, slots: slots, hooks: hooks };
