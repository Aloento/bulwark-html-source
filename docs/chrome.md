# Full-screen dialog: the host chrome override

Bulwark renders the plugin dialog itself (`components/plugins/plugin-dialog-host.tsx`): the
title, the `来自插件 …` line, a `⋮` menu, the close button, and a height cap of
`min(640, 90vh - 16)`. The plugin API exposes `title`, `slot`, `width`, `fill` and
`extraProps` — nothing else — so a plugin cannot remove the attribution line or go taller than
640 px on its own.

This repository ships an **optional** stylesheet that does it from the server side:
`chrome/plugin-chrome.css`. It is not part of the plugin zip and the plugin works without it —
you just get the stock dialog with the plugin frame inside a 640 px panel.

Everything in the sheet is scoped to `[data-plugin-dialog="html-source"]`, so other plugins'
dialogs keep the stock look.

## What it changes

| Selector | Effect |
|---|---|
| `[role="dialog"][aria-modal="true"]:has(> div[data-plugin-dialog="html-source"])` | overlay loses its 16 px gutter |
| `… > div[data-plugin-dialog="html-source"]` | panel becomes `100vw × 100vh`, no border, no radius |
| `[data-plugin-dialog-source]` | the "from plugin …" line is hidden |
| `header button[aria-haspopup="menu"]` | the `⋮` menu is hidden (the ✕ stays) |
| `> div:nth-child(2)` | drops the host's `px-6 py-4` wrapper padding |
| `h2`, header `button` | title 14 px, tighter header |

## How to inject it

nginx, on whatever `server` block serves the webmail:

```nginx
# serve the sheet
location = /plugin-chrome.css {
    root /var/www/bulwark-chrome;      # put plugin-chrome.css here
    default_type text/css;
    add_header Cache-Control "no-store";
}

# link it from every HTML document
location / {
    proxy_pass http://127.0.0.1:3000;
    sub_filter_once off;
    sub_filter '</head>' '<link rel="stylesheet" href="/plugin-chrome.css"></head>';
}
```

`sub_filter` needs the response uncompressed: send `Accept-Encoding ""` upstream, or the header
will not match. `sub_filter_types text/html` is the default and does not need repeating (nginx
warns about the duplicate if you do).

Then bump the query string (`?v=2`) or keep `Cache-Control: no-store`, and reload.

## Rollback

Delete the `sub_filter` line and reload nginx. The plugin keeps working; the dialog returns to
its stock 1040×640 shape with the attribution line back.

## Caveat

This is a selector-level override of another project's markup. If a Bulwark release renames
`data-plugin-dialog` or changes the header structure, the sheet quietly stops applying — the
dialog looks stock again, nothing breaks. Check `plugin-dialog-host.tsx` in the release you
are running if the look regresses after an upgrade.
