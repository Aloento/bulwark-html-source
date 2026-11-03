# How the HTML actually reaches the wire

Two obvious designs do not work. This note records what does, with the source locations, in
case you are writing a similar plugin or wondering whether the path still holds after an
upgrade.

## Why not just write the draft from another client?

Bulwark re-serialises whatever the editor holds. A draft written by a script and then opened
in the webmail comes back with every `<p>` carrying `margin: 4px 0` (the `addParagraphSpacing`
pass in `components/email/paragraph-breaks.ts`), and empty paragraphs becoming `<p><br></p>`
(`addTrailingParagraphBreaks`). Anything you "just put in the draft" is rewritten the moment
the composer touches it, and pressing Send serialises the editor, not your text.

## Why not `api.jmap.sendRaw`?

`api.jmap.sendRaw(rawBytes, identityId, opts)` exists and does exactly what we want — it takes
a complete RFC 5322 message — but it sits under a `// privileged tier only:` marker together
with `submitRaw`, `importRaw` and `fetchBlob`. Getting it means `"tier": "privileged"` plus
`crypto:full`, an administrator-installed and signed bundle, and a same-origin sandbox frame
(which is equivalent to full access to the webmail). That is a heavy price for an editor
feature, so the plugin does not use it. No privileged tier, nothing to sign.

## The path that works: `onTransformOutgoingEmail`

The send path, in order:

1. `components/email/email-composer.tsx:3882`
   `const outgoing = await emailHooks.onTransformOutgoingEmail.transform(transformInput);`
   — the host asks every plugin holding `email:send` to transform the `OutgoingEmail` object.
2. `components/email/email-composer.tsx:3885`
   `const sealedOutgoing = lastStage(outgoing.htmlBody, outgoing.textBody);`
   — the returned object is taken as final.
3. `components/email/email-composer.tsx:3925`
   `onSend({ ..., htmlBody: sealedOutgoing.html || undefined, ... })`
4. `lib/jmap/client.ts:5253` (`sendEmail`): with inline images it builds
   `emailCreate.bodyValues = { text: { value: body }, html: { value: htmlBody } }` plus a
   `bodyStructure` from `relatedBodyStructure(htmlBody, attachments)`
   (`lib/jmap/outgoing-body.ts`); without them it passes `bodyValues` and lets the server
   assemble the message.

There is **no second sanitiser between step 1 and the JMAP request**. `htmlBody` goes into
`bodyValues` as the string the hook returned, which is what makes byte-exact delivery possible:
the server builds the MIME from it (multipart/alternative, plus multipart/related when the
HTML references `cid:` parts).

The object the hook receives is `OutgoingEmail` (`lib/plugin-types.ts:1212`):

```ts
interface OutgoingEmail {
  to: string[]; cc: string[]; bcc: string[];
  subject: string; htmlBody: string; textBody: string;
  identityId: string; fromEmail?: string;
  attachments: OutgoingAttachment[];
  inReplyTo?: string; headers?: Record<string, string>;
  surface?: 'composer' | 'quick-reply' | 'plugin-forward';
  mode?: 'compose' | 'reply' | 'replyAll' | 'forward';
  authoredText?: string; externalRecipients?: string[];
}
```

Returning a shallow copy with `htmlBody` and `textBody` replaced is enough. Everything else —
recipients, attachments, headers, threading — stays exactly as the composer built it.

Note that this hook runs on **every** send, including replies. The plugin therefore keeps a
record per composer and only rewrites when the subject and the recipient set match that
record; anything else is returned untouched (and the user gets a toast if the record existed
but no longer matches).

## Why the dialog takes its state from `getSnapshot`

The `plugin-dialog` slot (`lib/plugin-slot-catalog.ts:53`) is a bare frame — it is handed
`extraProps` from `api.ui.openDialog({ slot, extraProps })` and nothing else, so it does not
receive the `draft` (subject, recipients) that the `composer-sidebar` slot gets. To know what
to key the record on, the plugin polls `api.composer.getSnapshot(composerId)`
(`lib/plugin-types.ts:1359`, `ComposerSnapshot = { revision, subject, text, to, cc, bcc,
attachments, pending }`) every two seconds while the dialog is open.

The arm record is written when the switch is turned on, not when the dialog opens, so closing
the dialog without arming leaves nothing behind.

## Two things that bite plugin authors

- **The host wrapper declares its own identifiers.** `lib/plugin-sandbox/runtime.tsx:1343`
  evaluates the bundle roughly as
  `new Function('module', 'exports', 'require', 'React', 'ReactDOM', 'JsxRuntime', 'console', code)`.
  A top-level `const React = require('react')` in the bundle therefore throws
  `Identifier 'React' has already been declared` and *the entire bundle fails to parse* — the
  plugin appears installed and enabled, with no button and no error in the page console (the
  message goes to the plugin sandbox's console). Use the injected `React`, or alias it.
- **The dialog's frame has no intrinsic height.** With `fill: true` the panel is sized from
  the frame's measured content; a root element at `height: 100%` with no minimum collapses to
  zero and the dialog opens blank. A `minHeight` on the root fixes it, as does any real content.

## When an upgrade breaks it

Check, in this order: `email-composer.tsx` still calls `onTransformOutgoingEmail` before
building the outgoing message; `sendEmail` in `lib/jmap/client.ts` still passes `htmlBody`
into `bodyValues` without sanitising it; `plugin-dialog` is still offered with `ui:observe`;
`api.composer.getSnapshot` still returns `subject`/`to`/`cc`/`bcc`. Each of these is a single
grep away, and `test.mjs` covers the plugin side of the contract.
